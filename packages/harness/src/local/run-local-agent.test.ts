import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { ApiAgentEvent } from "../domain/api-agent-event";
import { runLocalAgent } from "./run-local-agent";

const usage = {
	inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 5, text: 5, reasoning: 0 },
};

/** A model that plays back a fixed script, one response per request. */
function scriptedModel(
	script: ReadonlyArray<
		{ tool: string; input: Record<string, unknown> } | { text: string }
	>,
) {
	let request = 0;
	const seen: unknown[] = [];
	const model = new MockLanguageModelV4({
		doStream: async (options) => {
			seen.push(options.prompt);
			const step = script[request++];
			if (!step) throw new Error("The script ran out of responses.");
			const chunks: unknown[] =
				"tool" in step
					? [
							{
								type: "tool-call" as const,
								toolCallId: `call-${request}`,
								toolName: step.tool,
								input: JSON.stringify(step.input),
							},
							{
								type: "finish" as const,
								finishReason: {
									unified: "tool-calls" as const,
									raw: "tool_calls",
								},
								usage,
							},
						]
					: [
							{ type: "text-start" as const, id: "t" },
							{ type: "text-delta" as const, id: "t", delta: step.text },
							{ type: "text-end" as const, id: "t" },
							{
								type: "finish" as const,
								finishReason: { unified: "stop" as const, raw: "stop" },
								usage,
							},
						];
			return {
				stream: simulateReadableStream({
					initialDelayInMs: null,
					chunkDelayInMs: null,
					chunks: chunks as never[],
				}),
			};
		},
	});
	return { model, seen };
}

let directory: string;
let home: string;
const realHome = process.env.HOME;
beforeEach(async () => {
	// The runner writes workspace commands and archives under ~/.ytimesy.
	home = await mkdtemp(join(tmpdir(), "ytimesy-home-"));
	process.env.HOME = home;
	directory = await mkdtemp(join(tmpdir(), "ytimesy-local-agent-"));
	execFileSync("git", ["init", "-q", directory]);
	execFileSync("git", ["-C", directory, "config", "user.email", "a@b.c"]);
	execFileSync("git", ["-C", directory, "config", "user.name", "Test"]);
	await writeFile(join(directory, "notes.txt"), "alpha\n");
	execFileSync("git", ["-C", directory, "add", "."]);
	execFileSync("git", ["-C", directory, "commit", "-qm", "initial"]);
});
afterEach(async () => {
	process.env.HOME = realHome;
	await rm(directory, { recursive: true, force: true });
	await rm(home, { recursive: true, force: true });
});

it("does a task on this computer: creates a file, runs a command and answers", async () => {
	const { model, seen } = scriptedModel([
		{
			tool: "write",
			input: { path: "hello.txt", content: "hi there\n" },
		},
		{ tool: "bash", input: { command: "cat hello.txt && wc -l notes.txt" } },
		{ text: "Created hello.txt; notes.txt has one line." },
	]);
	const events: ApiAgentEvent[] = [];
	const result = await runLocalAgent({
		prompt: "Add hello.txt saying hi there, then show it",
		cwd: directory,
		model: { runtime: { model }, modelId: "claude-opus-5-5" },
		onEvent: (event) => {
			events.push(event);
		},
	});

	// The file really exists on disk, written by the harness's own tool.
	expect(await readFile(join(directory, "hello.txt"), "utf8")).toBe(
		"hi there\n",
	);
	// The command ran on this machine and its output went back to the model.
	const results = events.flatMap((event) =>
		event.type === "tool-result" ? [event] : [],
	);
	expect(results.map((event) => [event.name, event.failed ?? false])).toEqual([
		["write", false],
		["bash", false],
	]);
	expect(JSON.stringify(results[1]?.output)).toContain("hi there");
	expect(JSON.stringify(results[1]?.output)).toContain("1 notes.txt");
	// The model saw the task and the system instructions.
	expect(JSON.stringify(seen[0])).toContain("Add hello.txt saying hi there");
	expect(result.answer).toBe("Created hello.txt; notes.txt has one line.");
});

it("reports a failing tool call to the model instead of crashing", async () => {
	const { model } = scriptedModel([
		{
			tool: "edit",
			input: {
				path: "missing.txt",
				edits: [{ old_string: "x", new_string: "y" }],
			},
		},
		{ text: "That file does not exist." },
	]);
	const events: ApiAgentEvent[] = [];
	const result = await runLocalAgent({
		prompt: "Edit missing.txt",
		cwd: directory,
		model: { runtime: { model }, modelId: "claude-opus-5-5" },
		onEvent: (event) => {
			events.push(event);
		},
	});
	const failed = events.filter(
		(event) => event.type === "tool-result" && event.failed,
	);
	expect(failed).toHaveLength(1);
	expect(result.answer).toBe("That file does not exist.");
});

it("runs a program in code mode: one call, several tool calls inside the sandbox", async () => {
	const { model } = scriptedModel([
		{
			tool: "run_code",
			input: {
				code: [
					'await tools.write({ path: "from-code.txt", content: "made in the sandbox\\n" });',
					'const shown = await tools.bash({ command: "cat from-code.txt" });',
					"return shown;",
				].join("\n"),
			},
		},
		{ text: "Wrote it from code mode." },
	]);
	const events: ApiAgentEvent[] = [];
	const result = await runLocalAgent({
		prompt: "Write from-code.txt in one program",
		cwd: directory,
		model: { runtime: { model }, modelId: "claude-opus-5-5" },
		onEvent: (event) => {
			events.push(event);
		},
	});
	expect(await readFile(join(directory, "from-code.txt"), "utf8")).toBe(
		"made in the sandbox\n",
	);
	const output = JSON.stringify(
		events.flatMap((event) =>
			event.type === "tool-result" && event.name === "run_code" ? [event] : [],
		),
	);
	expect(output).toContain("made in the sandbox");
	expect(result.answer).toBe("Wrote it from code mode.");
});

it("keeps a checklist with update_plan", async () => {
	const { model } = scriptedModel([
		{
			tool: "update_plan",
			input: {
				plan: [
					{ step: "Read the notes", status: "in_progress" },
					{ step: "Report", status: "pending" },
				],
			},
		},
		{ text: "Planned." },
	]);
	const events: ApiAgentEvent[] = [];
	await runLocalAgent({
		prompt: "Plan the work",
		cwd: directory,
		model: { runtime: { model }, modelId: "claude-opus-5-5" },
		onEvent: (event) => {
			events.push(event);
		},
	});
	const plan = events.find(
		(event) => event.type === "tool-result" && event.name === "update_plan",
	);
	expect(JSON.stringify(plan)).toContain("Plan updated");
});

it("tells the model when a background command finishes, as the cloud product's notice would", async () => {
	const { model, seen } = scriptedModel([
		{
			tool: "bash",
			input: {
				command: "sleep 1 && echo finished > done.txt",
				background: true,
			},
		},
		{ text: "Started; I will wait for it." },
		{ tool: "bash", input: { command: "cat done.txt" } },
		{ text: "done.txt says finished." },
	]);
	const result = await runLocalAgent({
		prompt: "Run a slow command in the background",
		cwd: directory,
		model: { runtime: { model }, modelId: "claude-opus-5-5" },
	});

	expect(await readFile(join(directory, "done.txt"), "utf8")).toBe(
		"finished\n",
	);
	// The model's third request carries the runner's notice with the exit status.
	expect(JSON.stringify(seen[2])).toContain("Background command");
	expect(JSON.stringify(seen[2])).toMatch(/exitCode\\+": 0/);
	expect(result.answer).toBe("done.txt says finished.");
	// It starts tmux and polls a one-second job wait: about 2s on a laptop, about
	// 6s on a 2-vCPU Linux VM, so the default 5s timeout was too tight there.
}, 30_000);
