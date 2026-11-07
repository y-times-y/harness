import { expect, it } from "vitest";
import { applyApiProgress, recordedContextUsage } from "./api-progress";
import { SessionItemId } from "./ids";
import { type SessionItem, sessionItemsFromUnknown } from "./session-item";

it("retains tool inputs and results for inspection", () => {
	const started = applyApiProgress([], "turn", {
		type: "tool-call",
		id: "call",
		name: "bash",
		input: { command: "pnpm test" },
	});
	const completed = applyApiProgress(started, "turn", {
		type: "tool-result",
		id: "call",
		name: "bash",
		output: { stdout: "3 tests passed", exitCode: 0 },
	});
	expect(completed[0]).toMatchObject({
		input: expect.stringContaining("pnpm test"),
		output: expect.stringContaining("3 tests passed"),
	});
});

it("settles a failed tool call instead of leaving its spinner running", () => {
	const started = applyApiProgress([], "turn", {
		type: "tool-call",
		id: "call",
		name: "read_file",
		input: {},
	});
	const settled = applyApiProgress(started, "turn", {
		type: "tool-result",
		id: "call",
		name: "read_file",
		output: null,
		failed: true,
	});
	expect(settled).toEqual([
		{
			kind: "dynamicToolCall",
			id: "turn:call",
			tool: "read_file",
			status: "failed",
			input: "{}",
			output: "null",
		},
	]);
});

it("updates only the current turn and persists current context independently of cumulative usage", () => {
	const items: SessionItem[] = [
		{ kind: "userMessage", id: SessionItemId("old"), text: "old" },
		{ kind: "userMessage", id: SessionItemId("current"), text: "current" },
	];
	let updated = applyApiProgress(items, "turn", {
		type: "context",
		compacting: false,
		context: { last: { totalTokens: 500 }, modelContextWindow: 272000 },
	});
	updated = applyApiProgress(updated, "turn", {
		type: "context",
		compacting: false,
		context: { last: { totalTokens: 100 }, modelContextWindow: 272000 },
	});
	updated = applyApiProgress(updated, "turn", {
		type: "usage",
		usage: {
			inputTokens: 600,
			outputTokens: 20,
			uncachedInputTokens: 600,
			cacheReadTokens: 0,
			cacheWriteTokens: null,
		},
	});
	expect(updated[0]).toEqual(items[0]);
	expect(
		recordedContextUsage(
			sessionItemsFromUnknown(JSON.parse(JSON.stringify(updated))),
		)?.context?.last.totalTokens,
	).toBe(100);
});
it("keeps the last known context during compaction and clears the compacting state", () => {
	let items: SessionItem[] = [
		{ kind: "userMessage", id: SessionItemId("current"), text: "current" },
	];
	items = applyApiProgress(items, "turn", {
		type: "context",
		compacting: false,
		context: { last: { totalTokens: 100 }, modelContextWindow: 1000 },
	});
	items = applyApiProgress(items, "turn", {
		type: "context",
		compacting: true,
	});
	expect(recordedContextUsage(items)?.compacting).toBe(true);
	items = applyApiProgress(items, "turn", {
		type: "context",
		compacting: false,
	});
	expect(recordedContextUsage(items)?.compacting).toBe(false);
	expect(recordedContextUsage(items)?.context?.last.totalTokens).toBe(100);
});
