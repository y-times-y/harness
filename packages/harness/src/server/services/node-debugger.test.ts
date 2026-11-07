import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { NODE_DEBUGGER_SOURCE } from "./node-debugger";

const run = promisify(execFile);

it("sets a real breakpoint, steps, inspects locals without invoking getters, and stops its owned process", async () => {
	const cwd = await realpath(
		await mkdtemp(join(tmpdir(), "ytimesy-debugger-test-")),
	);
	const debuggerId = randomUUID();
	const ownerSessionId = "fixture-owner";
	const key = createHash("sha256")
		.update(JSON.stringify([cwd, ownerSessionId, debuggerId]))
		.digest("hex")
		.slice(0, 24);
	const directory = `/tmp/yt-debug-${process.getuid?.()}-${key}`;
	const invoke = async (action: string, extra = {}) => {
		const result = await run(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				NODE_DEBUGGER_SOURCE,
				process.cwd(),
				JSON.stringify({ cwd, ownerSessionId, debuggerId, action, ...extra }),
			],
			{ timeout: 15000, maxBuffer: 256000 },
		);
		return JSON.parse(result.stdout);
	};
	try {
		await writeFile(
			join(cwd, "main.mjs"),
			'let counter = 41;\nconst state = {label: "before", get secret() { throw new Error("getter was called"); }};\ncounter += 1;\nstate.label = "after";\nsetInterval(() => {}, 1000);\n',
		);
		expect(
			(await invoke("start", { path: "main.mjs", arguments: [] })).status,
		).toBe("ready");
		await invoke("breakpoint", { path: "main.mjs", line: 3, column: 1 });
		let paused = await invoke("continue");
		for (let attempt = 0; attempt < 10 && paused.status !== "paused"; attempt++)
			paused = await invoke("stack");
		expect(paused.status).toBe("paused");
		expect(paused.frames[0].path).toBe("main.mjs");
		expect(paused.frames[0].line).toBe(3);
		const variables = await invoke("variables", {
			objectId: paused.frames[0].scopes[0].objectId,
		});
		expect(
			variables.variables.find(
				(variable: { name: string }) => variable.name === "counter",
			).value,
		).toBe(41);
		const state = variables.variables.find(
			(variable: { name: string }) => variable.name === "state",
		);
		const properties = await invoke("variables", { objectId: state.objectId });
		expect(
			properties.variables.find(
				(variable: { name: string }) => variable.name === "secret",
			).accessor,
		).toBe(true);
		const next = await invoke("step_over");
		expect(next.status).toBe("paused");
		expect(next.frames[0].line).toBe(4);
		await expect(
			invoke("variables", { objectId: "arbitrary-object" }),
		).rejects.toThrow();
		await expect(
			invoke("breakpoint", { path: "../outside.mjs", line: 1, column: 1 }),
		).rejects.toThrow();
		expect((await invoke("stop")).stopped).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 200));
		await expect(invoke("stack")).rejects.toThrow();
	} finally {
		await invoke("stop").catch(() => {});
		await rm(directory, { recursive: true, force: true });
		await rm(cwd, { recursive: true, force: true });
	}
}, 30000);
