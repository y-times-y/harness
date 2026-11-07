import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
	COMMAND_STOP_SCRIPT,
	commandScopeRoot,
	scopedShellCommand,
} from "./api-command-scope";

/**
 * macOS has no /proc. The runner then reads a process's start time from `ps`.
 * These tests make /proc unavailable by pointing at a path that does not
 * exist, which exercises exactly that code on Linux.
 */
const WITHOUT_PROC = (text: string) =>
	text.replaceAll("/proc/", "/no-such-proc/");

async function waitFor<T>(read: () => Promise<T | undefined>, seconds = 10) {
	const deadline = Date.now() + seconds * 1000;
	while (Date.now() < deadline) {
		const value = await read().catch(() => undefined);
		if (value !== undefined) return value;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("Timed out waiting.");
}

it("records a ps-based start time for a command and Stop ends it, without /proc", async () => {
	const turnId = randomUUID();
	const root = commandScopeRoot(turnId);
	const marker = `ytimesy-portable-${randomUUID()}`;
	const command = WITHOUT_PROC(
		scopedShellCommand({
			turnId,
			cwd: "/tmp",
			command: `exec -a ${marker} sleep 60`,
			seconds: 120,
			commandId: "c1",
		}),
	);
	const runner = spawn("bash", ["-c", command], { stdio: "ignore" });
	const exited = new Promise<number | null>((resolve) =>
		runner.on("close", (code) => resolve(code)),
	);

	const record = await waitFor(async () =>
		JSON.parse(await readFile(join(root, "c1.json"), "utf8")),
	);
	// Not Linux's numeric tick: the start time as ps prints it.
	expect(String(record.start)).not.toMatch(/^\d+$/);
	expect(String(record.start)).toMatch(/\d{4}/);

	const stop = spawnSync(
		"python3",
		["-c", WITHOUT_PROC(COMMAND_STOP_SCRIPT), root, "c1"],
		{ encoding: "utf8" },
	);
	expect(stop.status, stop.stderr).toBe(0);
	const code = await Promise.race([
		exited,
		new Promise<"still running">((resolve) =>
			setTimeout(() => resolve("still running"), 8000),
		),
	]);
	expect(code).not.toBe("still running");
	expect(spawnSync("pgrep", ["-f", marker]).status).not.toBe(0);
});

it("does not stop a different process that reuses a recorded pid", async () => {
	const turnId = randomUUID();
	const root = commandScopeRoot(turnId);
	const victim = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
	try {
		const pid = victim.pid as number;
		const { writeFileSync, mkdirSync } = await import("node:fs");
		mkdirSync(root, { recursive: true });
		// A record from an earlier process that had this pid: the start time differs.
		writeFileSync(
			join(root, "old.json"),
			JSON.stringify({ pid, start: "Mon Jan  1 00:00:00 2001" }),
		);
		const stop = spawnSync(
			"python3",
			["-c", WITHOUT_PROC(COMMAND_STOP_SCRIPT), root, "old"],
			{ encoding: "utf8" },
		);
		expect(stop.status).toBe(0);
		expect(() => process.kill(pid, 0)).not.toThrow();
	} finally {
		victim.kill("SIGKILL");
	}
});

it("the debuggers read a process's start time through ps when /proc is missing", async () => {
	for (const file of ["dap-debugger.ts", "node-debugger.ts"]) {
		const source = readFileSync(join(import.meta.dirname, file), "utf8");
		const helper = /const startTick=async[^\n]+/.exec(source)?.[0];
		expect(helper, file).toBeDefined();
		const startTick = new Function(
			"readFile",
			"spawnSync",
			"process",
			`${WITHOUT_PROC(helper as string)}; return startTick;`,
		)(readFile, spawnSync, process) as (pid: number) => Promise<string>;
		const first = await startTick(process.pid);
		expect(first).toMatch(/\d{4}/);
		expect(await startTick(process.pid)).toBe(first);
		await expect(startTick(2 ** 22 + 12345)).rejects.toThrow(
			"Missing owned process identity",
		);
	}
});
