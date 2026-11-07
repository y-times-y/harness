import { type ToolSet, tool } from "ai";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import type { ApiAgentEvent } from "../../domain/api-agent-event";
import { composedAgentTools } from "./composed-agent-tools";

function fixture(tools: ToolSet, signal = new AbortController().signal) {
	const events = vi.fn(async (_event: ApiAgentEvent) => {});
	const composed = composedAgentTools({
		tools,
		signal,
		onEvent: events,
	}).compose_tools;
	const execute = composed.execute;
	if (!execute) throw new Error("Composition missing");
	return {
		events,
		run: (steps: unknown) =>
			execute(
				{ steps },
				{ toolCallId: "plan", messages: [], abortSignal: signal, context: {} },
			),
	};
}

it("overlaps reads then passes an exact result into a dependent tool, retaining individual receipts", async () => {
	let release: () => void = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const second = vi.fn(async () => {
		release();
		return { content: "second" };
	});
	const page = vi.fn(async ({ reference }: { reference: string }) => ({
		reference,
	}));
	const { run, events } = fixture({
		read_file: tool({
			inputSchema: z.object({ path: z.string() }),
			execute: async () => {
				await held;
				return { reference: "retained-output" };
			},
		}),
		read_files: tool({ inputSchema: z.object({}), execute: second }),
		read_tool_output: tool({
			inputSchema: z.object({ reference: z.string() }),
			execute: page,
		}),
	});
	const result = await run([
		{
			id: "first",
			tool: "read_file",
			arguments: { path: "a.ts" },
			dependsOn: [],
		},
		{ id: "second", tool: "read_files", arguments: {}, dependsOn: [] },
		{
			id: "page",
			tool: "read_tool_output",
			arguments: {
				reference: { $result: { step: "first", path: ["reference"] } },
			},
			dependsOn: ["first"],
		},
	]);
	expect(result).toMatchObject({ status: "completed" });
	expect(second).toHaveBeenCalledOnce();
	expect(page.mock.calls[0]?.[0]).toEqual({ reference: "retained-output" });
	expect(events).toHaveBeenCalledTimes(6);
});

it("rejects unavailable authority and unordered mutations before any side effects", async () => {
	const write = vi.fn();
	const { run } = fixture({
		create_file: tool({ inputSchema: z.object({}), execute: write }),
	});
	await expect(
		run([{ id: "a", tool: "publish", arguments: {}, dependsOn: [] }]),
	).rejects.toThrow("not available");
	await expect(
		run([
			{ id: "a", tool: "create_file", arguments: {}, dependsOn: [] },
			{ id: "b", tool: "create_file", arguments: {}, dependsOn: [] },
		]),
	).rejects.toThrow("serial");
	expect(write).not.toHaveBeenCalled();
});

it("blocks dependent edits when a prerequisite command is running or failed", async () => {
	for (const status of ["running", "interrupted", "stopped", 1]) {
		const write = vi.fn();
		const { run } = fixture({
			execute_command: tool({
				inputSchema: z.object({}),
				execute: async () => ({ status, id: "command" }),
			}),
			create_file: tool({ inputSchema: z.object({}), execute: write }),
		});
		expect(
			await run([
				{ id: "a", tool: "execute_command", arguments: {}, dependsOn: [] },
				{ id: "b", tool: "create_file", arguments: {}, dependsOn: ["a"] },
			]),
		).toMatchObject({
			status: "incomplete",
			steps: [
				{ status: typeof status === "string" ? "waiting" : "failed" },
				{ status: "blocked" },
			],
		});
		expect(write).not.toHaveBeenCalled();
	}
});

it("rejects cycles, forward references, missing paths and prototype access", async () => {
	const { run, events } = fixture({
		read_file: tool({
			inputSchema: z.object({}),
			execute: async () => ({ content: "x" }),
		}),
	});
	await expect(
		run([{ id: "a", tool: "read_file", arguments: {}, dependsOn: ["a"] }]),
	).rejects.toThrow("dependency");
	for (const path of [["missing"], ["__proto__"]]) {
		expect(
			await run([
				{ id: "a", tool: "read_file", arguments: {}, dependsOn: [] },
				{
					id: "b",
					tool: "read_file",
					arguments: { value: { $result: { step: "a", path } } },
					dependsOn: ["a"],
				},
			]),
		).toMatchObject({
			status: "incomplete",
			steps: [{ status: "completed" }, { status: "failed" }],
		});
		expect(events.mock.calls.at(-2)?.[0]).toMatchObject({
			type: "tool-call",
			id: "plan:step:b",
		});
	}
});

it("cancellation prevents any tool execution", async () => {
	const controller = new AbortController();
	controller.abort();
	const read = vi.fn();
	const { run } = fixture(
		{ read_file: tool({ inputSchema: z.object({}), execute: read }) },
		controller.signal,
	);
	await expect(
		run([{ id: "a", tool: "read_file", arguments: {}, dependsOn: [] }]),
	).rejects.toThrow();
	expect(read).not.toHaveBeenCalled();
});

it("never manufactures a composition surface for tool-free turns", () => {
	expect(
		composedAgentTools({
			tools: {},
			signal: new AbortController().signal,
			onEvent: async () => {},
		}),
	).toEqual({});
});

it("validates all static arguments before a preceding mutation can execute", async () => {
	const write = vi.fn();
	const { run } = fixture({
		create_file: tool({
			inputSchema: z.object({ path: z.string() }),
			execute: write,
		}),
		read_file: tool({
			inputSchema: z.object({ path: z.string() }),
			execute: vi.fn(),
		}),
	});
	await expect(
		run([
			{
				id: "write",
				tool: "create_file",
				arguments: { path: "a.ts" },
				dependsOn: [],
			},
			{
				id: "read",
				tool: "read_file",
				arguments: { path: 3 },
				dependsOn: ["write"],
			},
		]),
	).rejects.toThrow("No tools started");
	expect(write).not.toHaveBeenCalled();
});

it("composes authorized semantic edits and batched patches in explicit order, retaining wrapper identities", async () => {
	const calls: string[] = [];
	const tools = Object.fromEntries(
		["rename_symbol", "rename_file", "apply_patches"].map((name) => [
			name,
			tool({
				inputSchema: z.object({}),
				execute: async (_args, options) => {
					calls.push(`${name}:${options.toolCallId}`);
					return { completed: [], failedPath: null };
				},
			}),
		]),
	);
	const { run } = fixture(tools);
	expect(
		await run([
			{ id: "symbol", tool: "rename_symbol", arguments: {}, dependsOn: [] },
			{ id: "file", tool: "rename_file", arguments: {}, dependsOn: ["symbol"] },
			{
				id: "patch",
				tool: "apply_patches",
				arguments: {},
				dependsOn: ["symbol", "file"],
			},
		]),
	).toMatchObject({ status: "completed" });
	expect(calls).toEqual([
		"rename_symbol:plan:step:symbol",
		"rename_file:plan:step:file",
		"apply_patches:plan:step:patch",
	]);
});
