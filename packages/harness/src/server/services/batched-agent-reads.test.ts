import { tool } from "ai";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { batchedAgentReads } from "./batched-agent-reads";

function executeBatch(
	batch: ReturnType<typeof batchedAgentReads>,
	...args: Parameters<
		NonNullable<ReturnType<typeof batchedAgentReads>["execute"]>
	>
) {
	if (!batch.execute) throw new Error("Batch executor missing");
	return batch.execute(...args);
}

const options = {
	toolCallId: "batch",
	messages: [],
	abortSignal: new AbortController().signal,
	context: {},
};
const reads: Parameters<
	NonNullable<ReturnType<typeof batchedAgentReads>["execute"]>
>[0]["reads"] = [
	{ tool: "read_code", arguments: { taskId: "child" } },
	{
		tool: "search_files",
		arguments: { taskId: "child", references: ["check"] },
	},
];

it("reads independent evidence concurrently and retains full original receipts and cursors", async () => {
	let release!: (value: unknown) => void;
	const diff = vi.fn(
		() =>
			new Promise((resolve) => {
				release = resolve;
			}),
	);
	const checks = vi.fn(async () => ({
		sourcesCurrent: true,
		stdout: { nextStart: 12000 },
	}));
	const batch = batchedAgentReads(
		{
			read_code: tool({
				inputSchema: z.object({ taskId: z.string() }),
				execute: diff,
			}),
			search_files: tool({
				inputSchema: z.object({
					taskId: z.string(),
					references: z.array(z.string()),
				}),
				execute: checks,
			}),
		},
		options.abortSignal,
	);
	const pending = executeBatch(batch, { reads: [...reads] }, options);
	await vi.waitFor(() => expect(checks).toHaveBeenCalledOnce());
	release({ sha256: "exact", nextStart: null });
	expect(await pending).toMatchObject({
		reads: [
			{ result: { sha256: "exact", nextStart: null } },
			{ result: { sourcesCurrent: true, stdout: { nextStart: 12000 } } },
		],
	});
	expect(diff).toHaveBeenCalledWith(
		{ taskId: "child" },
		expect.objectContaining({ toolCallId: "batch:read:0" }),
	);
});

it("rejects write tools, missing executors and cancellation before starting reads", async () => {
	const read = vi.fn();
	const batch = batchedAgentReads(
		{ read_code: tool({ inputSchema: z.object({}), execute: read }) },
		options.abortSignal,
	);
	await expect(
		executeBatch(batch, { reads: [...reads] }, options),
	).rejects.toThrow("No reads started");
	await expect(
		executeBatch(
			batch,
			{ reads: [reads[0], { tool: "apply_patches", arguments: {} }] } as never,
			options,
		),
	).rejects.toThrow();
	await expect(
		executeBatch(
			batch,
			{ reads: [reads[0], reads[0]] },
			{ ...options, abortSignal: AbortSignal.abort() },
		),
	).rejects.toThrow();
	expect(read).not.toHaveBeenCalled();
});

it("does not turn a failed read into successful evidence or expose its raw error", async () => {
	const batch = batchedAgentReads(
		{
			read_code: tool({
				inputSchema: z.object({}),
				execute: (): unknown => {
					throw new Error("private detail");
				},
			}),
			search_files: tool({
				inputSchema: z.object({}),
				execute: async () => ({ sourcesCurrent: false }),
			}),
		},
		options.abortSignal,
	);
	const result = await executeBatch(batch, { reads: [...reads] }, options);
	expect(result).toMatchObject({
		reads: [
			{ status: "failed" },
			{ status: "completed", result: { sourcesCurrent: false } },
		],
	});
	expect(JSON.stringify(result)).not.toContain("private detail");
});

it("validates nested arguments before invoking a read", async () => {
	const diff = vi.fn(async () => ({ sha256: "exact" }));
	const batch = batchedAgentReads(
		{
			read_code: tool({
				inputSchema: z.object({ taskId: z.string() }),
				execute: diff,
			}),
		},
		options.abortSignal,
	);
	const result = await executeBatch(
		batch,
		{
			reads: [{ tool: "read_code", arguments: { taskId: 3 } }, reads[0]],
		},
		options,
	);
	expect(result).toMatchObject({
		reads: [
			{ status: "failed" },
			{ status: "completed", result: { sha256: "exact" } },
		],
	});
	expect(diff).toHaveBeenCalledTimes(1);
});
