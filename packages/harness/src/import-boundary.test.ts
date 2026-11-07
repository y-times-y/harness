import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const harnessSource = join(import.meta.dirname);

const forbiddenProductPaths = [
	"server/adapters",
	"server/auth",
	"server/jobs",
] as const;

const forbiddenPackages = [
	"pg",
	"pg-boss",
	"freestyle",
	"posthog-node",
	"octokit",
	"@octokit/rest",
	"better-auth",
	"isomorphic-git",
] as const;

/**
 * Harness modules that still read process.env as a default parameter value.
 * TODO: each needs its env injected by the product so the harness never reads
 * process.env itself; remove the entry when that is done.
 */
const processEnvAllowlist: Readonly<Record<string, string>> = {
	"domain/claude-code-route.ts": "default `env` parameter feature flag",
	"domain/development-environment.ts": "default `env` parameter feature flag",
	"domain/memory-repo.ts": "default `env` parameter of memoryAppUrl",
	"domain/sidekick-classifier.ts": "default `env` parameter feature flag",
	"domain/sidekick.ts": "default `env` parameter feature flag",
	"domain/xai-subscription.ts": "default `env` parameter feature flag",
	"local/local-machines.ts":
		"hands the process environment to the commands the agent runs",
	"local/bin.ts":
		"the command line's entry point hands its environment to the runner",
	"server/providers/openrouter-official.ts":
		"default `env` parameter feature flag",
	"server/services/api-command-scope.ts":
		"reads the background-command time limit from the environment",
	"server/services/dap-debugger.ts":
		"inside the script text it sends to the machine, not read by the harness",
	"server/services/node-debugger.ts":
		"inside the script text it sends to the machine, not read by the harness",
	"server/services/code-tooling.ts":
		"inside the script text it sends to the machine, not read by the harness",
	"server/services/step-timing.ts": "debug flag read from the environment",
};

const importSpecifier =
	/(?:from\s*|import\s*\(\s*|import\s+|require\(\s*)["']([^"']+)["']/g;

function harnessFiles() {
	return readdirSync(harnessSource, { recursive: true, encoding: "utf8" })
		.filter((file) => file.endsWith(".ts"))
		.map((file) => file.split("\\").join("/"));
}

function importedSpecifiers(source: string) {
	return [...source.matchAll(importSpecifier)].map((match) => match[1] ?? "");
}

function isForbiddenSpecifier(specifier: string) {
	const productPath = specifier.replace(/^(#|@)\/|^(\.\.?\/)+/, "");
	if (forbiddenProductPaths.some((path) => productPath.startsWith(path))) {
		return true;
	}
	return forbiddenPackages.some(
		(name) => specifier === name || specifier.startsWith(`${name}/`),
	);
}

describe("harness import boundary", () => {
	it("imports no product adapters, auth, jobs or cloud packages", () => {
		const violations = harnessFiles().flatMap((file) =>
			importedSpecifiers(readFileSync(join(harnessSource, file), "utf8"))
				.filter(isForbiddenSpecifier)
				.map((specifier) => `${file} imports ${specifier}`),
		);
		expect(violations).toEqual([]);
	});

	it("reads process.env only in allowlisted files", () => {
		const violations = harnessFiles()
			.filter((file) => !file.endsWith(".test.ts"))
			.filter((file) => !(file in processEnvAllowlist))
			.filter((file) =>
				/\bprocess\.env\b/.test(
					readFileSync(join(harnessSource, file), "utf8"),
				),
			);
		expect(violations).toEqual([]);
	});

	it("keeps no stale process.env allowlist entries", () => {
		const stale = Object.keys(processEnvAllowlist).filter(
			(file) =>
				!/\bprocess\.env\b/.test(
					readFileSync(join(harnessSource, file), "utf8"),
				),
		);
		expect(stale).toEqual([]);
	});

	it("flags a forbidden import", () => {
		expect(isForbiddenSpecifier("#/server/adapters/github")).toBe(true);
		expect(isForbiddenSpecifier("../../server/auth/token-vault")).toBe(true);
		expect(isForbiddenSpecifier("@octokit/rest")).toBe(true);
		expect(isForbiddenSpecifier("pg/lib/client")).toBe(true);
		expect(isForbiddenSpecifier("zod")).toBe(false);
		expect(isForbiddenSpecifier("./model-failover")).toBe(false);
	});
});
