import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { WorkspaceId } from "../domain/ids";
import { commandEnvironment, localMachines } from "./local-machines";

it("keeps the model providers' API keys out of the commands' environment", () => {
	const env = commandEnvironment(
		{
			ANTHROPIC_API_KEY: "a",
			OPENAI_API_KEY: "b",
			GEMINI_API_KEY: "c",
			OPENROUTER_API_KEY: "d",
			HOME: "/home/x",
			PATH: "/usr/bin",
		},
		"/home/x/.ytimesy/bin",
	);
	expect(env).toEqual({
		HOME: "/home/x",
		PATH: "/home/x/.ytimesy/bin:/usr/bin",
	});
});

it("runs a command in the given directory and reports its exit code", async () => {
	const directory = mkdtempSync(join(tmpdir(), "k-machines-"));
	process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-leak";
	try {
		const machines = localMachines(directory);
		const ran = await machines.exec(
			WorkspaceId("local"),
			'pwd; echo "key=[$ANTHROPIC_API_KEY]"; exit 3',
		);
		expect(ran.exitCode).toBe(3);
		expect(ran.stdout).toContain("key=[]");
		expect(ran.stdout).not.toContain("should-not-leak");
	} finally {
		delete process.env.ANTHROPIC_API_KEY;
	}
});
