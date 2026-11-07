import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	AGENT_SECRETS_ENV_PATH,
	agentSecretsEnvFile,
	parseProjectSecretKind,
	parseProjectSecretName,
	parseProjectSecretValue,
	projectSecretsInstructions,
	REDACTED,
	redactSecretValues,
	SECRET_COMMIT_GUARD,
	secretForms,
	sessionReceivesProjectSecrets,
} from "./project-secret";

describe("project secrets", () => {
	it("exports environment variables and runtime secrets, never build secrets", () => {
		expect(
			agentSecretsEnvFile([
				{ name: "OPENAI_API_KEY", value: "sk-secret'value", kind: "runtime" },
				{ name: "APP_MODE", value: "staging", kind: "environment" },
				{ name: "NPM_TOKEN", value: "npm-build-only", kind: "build" },
			]),
		).toBe(
			"export OPENAI_API_KEY='sk-secret'\\''value'\nexport APP_MODE='staging'\nYTIMESY_REDACTED_SECRETS='OPENAI_API_KEY'\n",
		);
		expect(agentSecretsEnvFile([])).toBe("# No project secrets configured.\n");
	});

	it("rejects reserved or malformed names, kinds and short runtime values", () => {
		expect(parseProjectSecretName("GH_TOKEN")).toBe("GH_TOKEN");
		expect(() => parseProjectSecretName("path")).toThrow(/uppercase/);
		expect(() => parseProjectSecretName("PATH")).toThrow(/reserved/);
		expect(() => parseProjectSecretName("YTIMESY_REDACTED_SECRETS")).toThrow(
			/reserved/,
		);
		expect(() => parseProjectSecretValue("   ")).toThrow(/required/);
		expect(() => parseProjectSecretValue("abc", "runtime")).toThrow(/at least/);
		expect(parseProjectSecretValue("abc", "environment")).toBe("abc");
		expect(() => parseProjectSecretKind("secret")).toThrow(/type/);
	});

	it("tells the agent secret names by kind, never values", () => {
		expect(projectSecretsInstructions([])).toBe("");
		const text = projectSecretsInstructions([
			{ name: "STRIPE_KEY", kind: "runtime" },
			{ name: "API_BASE", kind: "environment" },
			{ name: "NPM_TOKEN", kind: "build" },
		]);
		expect(text).toContain(": STRIPE_KEY.");
		expect(text).toContain("Environment variables: API_BASE.");
		expect(text).toContain("not set for you): NPM_TOKEN.");
		expect(text).toContain("screenshots are not redacted");
	});

	it("redacts common encodings of a runtime value", () => {
		const secret = "sk_live_51HxQz9Ab/Cd+Ef";
		const bytes = Buffer.from(secret);
		const outputs = [
			JSON.stringify({ token: secret }),
			`https://api.test/?key=${encodeURIComponent(secret)}`,
			bytes.toString("hex"),
			bytes.toString("hex").toUpperCase(),
			bytes.toString("base64"),
			bytes.toString("base64url"),
		];
		// Inside a larger base64 blob at every byte alignment.
		for (const prefix of [0, 1, 2, 3, 4, 5])
			outputs.push(
				Buffer.concat([
					Buffer.alloc(prefix, 7),
					bytes,
					Buffer.from("trailing data"),
				]).toString("base64"),
			);
		for (const output of outputs) {
			const redacted = redactSecretValues(output, [secret]);
			expect(redacted, output).toContain(REDACTED);
		}
	});

	it("matches encodings only for longer values", () => {
		expect(secretForms("abcdef1")).toEqual(["abcdef1"]);
		expect(secretForms("abcdefgh").length).toBeGreaterThan(1);
		expect(redactSecretValues("a normal sentence", ["abcdefgh"])).toBe(
			"a normal sentence",
		);
	});

	it("redacts runtime values anywhere in tool output", () => {
		expect(
			redactSecretValues(
				{ stdout: "key=sk-live-123456 ok", lines: ["sk-live-123456"], code: 0 },
				["sk-live-123456"],
			),
		).toEqual({
			stdout: `key=${REDACTED} ok`,
			lines: [REDACTED],
			code: 0,
		});
	});

	it("refuses commits whose changes or unpushed history contain a runtime value", () => {
		const repo = mkdtempSync(join(tmpdir(), "secret-guard-"));
		const env = join(repo, "..", `${repo.split("/").pop()}.env`);
		writeFileSync(
			env,
			agentSecretsEnvFile([
				{ name: "STRIPE_KEY", value: "sk_test_abcdef123", kind: "runtime" },
			]),
		);
		const guard = SECRET_COMMIT_GUARD.replaceAll(AGENT_SECRETS_ENV_PATH, env);
		const sh = (script: string) =>
			execFileSync("bash", ["-c", script], { cwd: repo, encoding: "utf8" });
		sh(
			"git init -q && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m init",
		);
		writeFileSync(join(repo, "safe.txt"), "uses process.env.STRIPE_KEY\n");
		expect(() => sh(`git add -A && ${guard}`)).not.toThrow();
		writeFileSync(join(repo, "leak.txt"), "key = sk_test_abcdef123\n");
		expect(() => sh(`git add -A && ${guard}`)).toThrow(/STRIPE_KEY/);
		expect(sh("git diff --cached --name-only")).toBe("");
	});
});

describe("who receives project secrets", () => {
	it("gives the builder and writers the env file, never read-only subagents", () => {
		expect(sessionReceivesProjectSecrets({})).toBe(true);
		expect(sessionReceivesProjectSecrets({ agentRole: null })).toBe(true);
		expect(sessionReceivesProjectSecrets({ agentRole: "writer" })).toBe(true);
		for (const agentRole of ["researcher", "reviewer", "checker"] as const)
			expect(sessionReceivesProjectSecrets({ agentRole })).toBe(false);
	});
});
