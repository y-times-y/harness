import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { DAP_DEBUGGER_SOURCE } from "./dap-debugger";

const run = promisify(execFile);
it.skipIf(!existsSync(resolve(".ytimesy/debug-runtime/bin/python")))(
	"launches real debugpy, hits a breakpoint, inspects locals, steps and rejects old pause references",
	async () => {
		const cwd = await realpath(await mkdtemp(join(tmpdir(), "yt-dap-python-")));
		const debuggerId = randomUUID(),
			ownerSessionId = "python-fixture";
		const python = resolve(".ytimesy/debug-runtime/bin/python");
		const invoke = async (action: string, extra = {}) =>
			JSON.parse(
				(
					await run(
						process.execPath,
						[
							"--input-type=module",
							"-e",
							DAP_DEBUGGER_SOURCE,
							process.cwd(),
							JSON.stringify({
								cwd,
								debuggerId,
								ownerSessionId,
								action,
								python,
								...extra,
							}),
						],
						{ timeout: 30000, maxBuffer: 256000 },
					)
				).stdout,
			);
		try {
			await writeFile(
				join(cwd, "main.py"),
				"counter = 41\nlabel = 'before'\ncounter += 1\nlabel = 'after'\nprint(counter, label)\n",
			);
			let state = await invoke("start", {
				adapter: "python",
				path: "main.py",
				arguments: [],
				breakpoints: [{ path: "main.py", lines: [3] }],
			});
			for (
				let attempt = 0;
				attempt < 20 && state.status !== "paused";
				attempt++
			)
				state = await invoke("stack");
			expect(state.status).toBe("paused");
			state = await invoke("continue");
			for (
				let attempt = 0;
				attempt < 20 && state.frames[0]?.line !== 3;
				attempt++
			)
				state = await invoke("stack");
			expect(state.frames[0].line).toBe(3);
			const oldPause = state.pauseId;
			const scopes = await invoke("scopes", {
				frameId: state.frames[0].id,
				pauseId: state.pauseId,
			});
			const reference = scopes.scopes.find((scope: { name: string }) =>
				/local/i.test(scope.name),
			).reference;
			const variables = await invoke("variables", {
				reference,
				pauseId: oldPause,
			});
			expect(
				variables.variables.find(
					(variable: { name: string }) => variable.name === "counter",
				).value,
			).toBe("41");
			const next = await invoke("step_over");
			expect(next.status).toBe("paused");
			expect(next.frames[0].line).toBe(4);
			await expect(
				invoke("variables", { reference, pauseId: oldPause }),
			).rejects.toThrow();
			await expect(
				invoke("breakpoints", { path: "../outside.py", lines: [1] }),
			).rejects.toThrow();
			expect((await invoke("stop")).stopped).toBe(true);
		} finally {
			await invoke("stop").catch(() => {});
			await rm(cwd, { recursive: true, force: true });
		}
	},
	60000,
);
