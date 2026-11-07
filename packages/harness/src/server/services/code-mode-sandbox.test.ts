import { describe, expect, it } from "vitest";
import { runSandboxedProgram } from "./code-mode-sandbox";

const run = (
	code: string,
	call: (name: string, args: unknown, index: number) => Promise<unknown> = () =>
		Promise.resolve(null),
	limits = {},
) =>
	runSandboxedProgram({
		code,
		tools: ["read", "fail"],
		call,
		signal: new AbortController().signal,
		limits,
	});

describe("code mode sandbox", () => {
	it("returns the program's JSON value and captured console output", async () => {
		const outcome = await run(
			'console.log("hi", { a: 1 }); console.warn("careful"); return { sum: 1 + 2 };',
		);
		expect(outcome).toMatchObject({
			ok: true,
			result: '{"sum":3}',
			console: 'hi {"a":1}\n[warn] careful\n',
			toolCalls: 0,
		});
	});

	it("exposes no host capabilities", async () => {
		const outcome = await run(`return {
			fetch: typeof fetch, require: typeof require, process: typeof process,
			setTimeout: typeof setTimeout, importScripts: typeof importScripts,
			call: typeof __ytimesyCall, Deno: typeof Deno, std: typeof std, os: typeof os,
			WebAssembly: typeof WebAssembly,
		};`);
		expect(JSON.parse(outcome.result as string)).toEqual({
			fetch: "undefined",
			require: "undefined",
			process: "undefined",
			setTimeout: "undefined",
			importScripts: "undefined",
			call: "undefined",
			Deno: "undefined",
			std: "undefined",
			os: "undefined",
			WebAssembly: "undefined",
		});
	});

	it("cannot import modules", async () => {
		const outcome = await run('const fs = await import("node:fs"); return 1;');
		expect(outcome.ok).toBe(false);
	});

	it("stops runaway CPU by interrupt ticks even when the clock is frozen", async () => {
		const started = Date.now();
		const outcome = await run("while (true) {}", undefined, {
			interruptTicks: 200,
			cpuMs: 60_000,
		});
		expect(outcome).toMatchObject({
			ok: false,
			error: "Program exceeded its CPU budget.",
		});
		expect(Date.now() - started).toBeLessThan(10_000);
	});

	it("stops runaway CPU by wall clock", async () => {
		const outcome = await run("for (;;) {}", undefined, {
			interruptTicks: 1e9,
			cpuMs: 50,
		});
		expect(outcome.error).toBe("Program exceeded its CPU budget.");
	});

	it("bounds memory by bytes and recovers for the next program", async () => {
		const started = performance.now();
		const outcome = await run(
			'const parts = []; for (;;) parts.push("x".repeat(1 << 16) + parts.length);',
		);
		expect(outcome.ok).toBe(false);
		expect(outcome.error).toMatch(/out of memory/);
		expect(performance.now() - started).toBeLessThan(3_000);
		const next = await run(
			'const parts = []; for (let i = 0; i < 64; i++) parts.push("y".repeat(1 << 16) + i); return parts.length;',
		);
		expect(next).toMatchObject({ ok: true, result: "64" });
	});

	it("caps the result and console output", async () => {
		const outcome = await run(
			'for (let i = 0; i < 100; i++) console.log("line " + i); return "y".repeat(50000);',
			undefined,
			{ resultBytes: 1000, consoleBytes: 100 },
		);
		expect(outcome.ok).toBe(true);
		expect(outcome.result).toHaveLength(1000);
		expect(outcome.resultTruncated).toBe(true);
		expect(outcome.console.length).toBeLessThanOrEqual(100);
		expect(outcome.consoleTruncated).toBe(true);
	});

	it("routes tool calls to the host and runs Promise.all concurrently", async () => {
		let active = 0;
		let peak = 0;
		const seen: Array<[string, unknown, number]> = [];
		const outcome = await run(
			`const results = await Promise.all([1, 2, 3].map((n) => tools.read({ path: "f" + n })));
			return results.map((r) => r.text.length);`,
			async (name, args, index) => {
				seen.push([name, args, index]);
				active++;
				peak = Math.max(peak, active);
				await new Promise((resolve) => setTimeout(resolve, 20));
				active--;
				return { text: "x".repeat(index + 1) };
			},
		);
		expect(outcome).toMatchObject({
			ok: true,
			result: "[1,2,3]",
			toolCalls: 3,
		});
		expect(peak).toBe(3);
		expect(seen).toEqual([
			["read", { path: "f1" }, 0],
			["read", { path: "f2" }, 1],
			["read", { path: "f3" }, 2],
		]);
	});

	it("bounds concurrency", async () => {
		let active = 0;
		let peak = 0;
		const outcome = await run(
			"await Promise.all(Array.from({ length: 10 }, () => tools.read({}))); return 1;",
			async () => {
				active++;
				peak = Math.max(peak, active);
				await new Promise((resolve) => setTimeout(resolve, 5));
				active--;
				return null;
			},
			{ maxConcurrentToolCalls: 2 },
		);
		expect(outcome.ok).toBe(true);
		expect(peak).toBe(2);
	});

	it("resolves a failed tool call to a failure value, so Promise.all keeps the other results", async () => {
		const call = async (name: string) => {
			if (name === "fail") throw new Error("disk on fire");
			return "fine";
		};
		const both = await run(
			`const [a, b] = await Promise.all([tools.fail({}), tools.read({})]);
			return { a, b, failed: a.ok === false, okIsUndefined: b.ok === undefined, text: \`\${a}\` };`,
			call,
		);
		expect(JSON.parse(both.result as string)).toEqual({
			a: { ok: false, tool: "fail", error: "disk on fire" },
			b: "fine",
			failed: true,
			okIsUndefined: true,
			text: "[fail failed] disk on fire",
		});
		const thrown = await run("throw new Error('mine');");
		expect(thrown.ok).toBe(false);
		expect(thrown.error).toMatch(/^Error: mine/);
		const syntax = await run("return (;");
		expect(syntax.ok).toBe(false);
		expect(syntax.error).toMatch(/SyntaxError/);
	});

	it("keeps text() output as the program goes, even when it later throws", async () => {
		const outcome = await run(
			"text('first', { n: 1 }); print('second'); throw new Error('late');",
		);
		expect(outcome.ok).toBe(false);
		expect(outcome.console).toBe('first {"n":1}\nsecond\n');
	});

	it("limits the number of tool calls", async () => {
		const outcome = await run(
			"let n = 0; for (let i = 0; i < 5; i++) { const r = await tools.read({}); if (r && r.ok === false) return { n, message: r.error }; n++; }",
			async () => null,
			{ maxToolCalls: 3 },
		);
		expect(JSON.parse(outcome.result as string)).toMatchObject({
			n: 3,
			message: expect.stringMatching(/Tool call limit reached/),
		});
	});

	it("reports a program that awaits something that never settles", async () => {
		const outcome = await run("await new Promise(() => {}); return 1;");
		expect(outcome.ok).toBe(false);
		expect(outcome.error).toMatch(/never settle/);
	});

	it("waits for started tool calls before returning but refuses later ones", async () => {
		const finished: string[] = [];
		const outcome = await run(
			`tools.read({ id: "a" }).then(() => tools.read({ id: "late" }));
			return "early";`,
			async (_name, args) => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				finished.push((args as { id: string }).id);
				return null;
			},
		);
		expect(outcome.result).toBe('"early"');
		expect(finished).toEqual(["a"]);
	});

	it("rejects oversized tool results", async () => {
		const outcome = await run(
			"return (await tools.read({})).error;",
			async () => "z".repeat(5000),
			{ toolResultBytes: 1000 },
		);
		expect(outcome.result).toMatch(/exceeds 1000 bytes/);
	});

	it("stops when the step is aborted", async () => {
		const controller = new AbortController();
		const outcome = runSandboxedProgram({
			code: "await tools.read({}); return 1;",
			tools: ["read"],
			signal: controller.signal,
			call: async () => {
				controller.abort(new Error("step deadline"));
				return null;
			},
		});
		await expect(outcome).rejects.toThrow("step deadline");
	});
});
