import type { ModelMessage } from "ai";
import { expect, it, vi } from "vitest";
import {
	CONTEXT_SUMMARY_INSTRUCTIONS,
	compactApiHistory,
	contextMeasurement,
	contextTokenPressure,
	EMPTY_SUMMARY_NOTICE,
	estimateContextTokens,
	modelContextBudget,
	retainedUserMessages,
	UNKNOWN_CONTEXT_WINDOW,
} from "./api-agent-context";

it("uses measured reasoning usage without tokenizing its opaque encoding again", () => {
	const history: ModelMessage[] = [
		{ role: "user", content: "Implement" },
		{
			role: "assistant",
			content: [
				{
					type: "reasoning",
					text: "",
					providerOptions: { openai: { encryptedContent: "x".repeat(180000) } },
				},
			],
		},
	];
	const measurement = contextMeasurement([], history, 1000, 2000);
	expect(contextTokenPressure(history, measurement)).toBe(3000);
	// Ciphertext counts by the tokens it stands for (about 8 bytes each), not as text.
	expect(contextTokenPressure(history)).toBeGreaterThan(22_500);
	expect(contextTokenPressure(history)).toBeLessThan(23_000);
	expect(
		contextTokenPressure(
			[...history, { role: "user", content: "New requirement" }],
			measurement,
		),
	).toBeGreaterThan(3000);
});

it("counts unsent function results and subsequent injections on top of provider usage", () => {
	const before: ModelMessage[] = [{ role: "user", content: "Read source" }];
	const response: ModelMessage[] = [
		{
			role: "assistant",
			content: [
				{
					type: "tool-call",
					toolCallId: "call",
					toolName: "read_file",
					input: { path: "source.ts" },
				},
			],
		},
		{
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "call",
					toolName: "read_file",
					output: { type: "text", value: "x".repeat(30000) },
				},
			],
		},
	];
	const measurement = contextMeasurement(before, response, 500, 100);
	expect(
		contextTokenPressure([...before, ...response], measurement),
	).toBeGreaterThan(10600);
	expect(
		contextTokenPressure(
			[...before, ...response, { role: "user", content: "y".repeat(3000) }],
			measurement,
		),
	).toBeGreaterThan(11600);
});

it("reserves output, instructions and tools within the selected model's token window", () => {
	const small = modelContextBudget({
		contextWindow: 16_000,
		maxOutputTokens: 4096,
		fixedTokens: 1000,
	});
	const large = modelContextBudget({
		contextWindow: 200_000,
		maxOutputTokens: 4096,
		fixedTokens: 1000,
	});
	expect(small.inputLimitTokens).toBe(10_200);
	expect(large.compactAtTokens).toBeGreaterThan(small.compactAtTokens);
	expect(
		modelContextBudget({
			contextWindow: 200_000,
			autoCompactTokenLimit: 80_000,
		}).compactAtTokens,
	).toBe(80_000);
	expect(estimateContextTokens("你好")).toBeGreaterThan(
		estimateContextTokens("hi"),
	);
});

it("compacts the first long-running turn while retaining its request", async () => {
	const messages: ModelMessage[] = [
		{ role: "user", content: "Implement the feature" },
		{ role: "assistant", content: "Investigation ".repeat(8000) },
		{
			role: "assistant",
			content: [
				{
					type: "reasoning",
					text: "Current reasoning",
					providerOptions: { google: { thoughtSignature: "signature" } },
				},
				{ type: "text", text: "Continue" },
			],
		},
	];
	const summarize = vi.fn(
		async () => "Feature is pending; inspected src/main.ts.",
	);
	const result = await compactApiHistory(messages, summarize);
	expect(result.compacted).toBe(true);
	expect(result.messages.slice(1)).toEqual([messages[0], messages[2]]);
	expect(summarize).toHaveBeenCalled();
});

it("bounds the working checkpoint without expanding the provider's safety limit", () => {
	const large = modelContextBudget({
		contextWindow: 272000,
		workingContextTokens: 32000,
	});
	expect(large.compactAtTokens).toBe(32000);
	expect(large.inputLimitTokens).toBeGreaterThan(32000);
	expect(
		modelContextBudget({
			contextWindow: 272000,
			autoCompactTokenLimit: 24000,
			workingContextTokens: 32000,
		}).compactAtTokens,
	).toBe(24000);
	expect(
		modelContextBudget({ contextWindow: 16000, workingContextTokens: 32000 })
			.compactAtTokens,
	).toBeLessThan(16000);
});

it("retains delegation identities when bounding earlier repository outputs", async () => {
	const pair = (id: string, name: string, value: string): ModelMessage[] => [
		{
			role: "assistant",
			content: [
				{ type: "tool-call", toolCallId: id, toolName: name, input: {} },
			],
		},
		{
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: id,
					toolName: name,
					output: { type: "text", value },
				},
			],
		},
	];
	const messages: ModelMessage[] = [
		{ role: "user", content: "Fix UI" },
		...pair("created", "create_task", "active-child"),
		...pair("large", "read_file", "x".repeat(95000)),
		...pair("last", "read_file", "small"),
		{ role: "assistant", content: "Continue" },
	];
	const summarize = vi.fn(
		async () =>
			"Delegated work to active-child; earlier repository output inspected.",
	);
	const result = await compactApiHistory(messages, summarize);
	expect(JSON.stringify(result.messages)).toContain("active-child");
	expect(result.messages.slice(-3)).toEqual(messages.slice(-3));
	expect(JSON.stringify(summarize.mock.calls)).toContain("x".repeat(95000));
});

it("archives original opaque state before replacing older history and preserves recent signed reasoning", async () => {
	const messages: ModelMessage[] = [
		{ role: "user", content: "Old task" },
		{
			role: "assistant",
			content: [
				{
					type: "reasoning",
					text: "Earlier decision ".repeat(7000),
					providerOptions: {
						openai: { reasoningEncryptedContent: "opaque-old" },
					},
				},
			],
		},
		{ role: "user", content: "Continue" },
		{
			role: "assistant",
			content: [
				{
					type: "reasoning",
					text: "",
					providerOptions: {
						anthropic: {
							redactedData: "opaque-current",
							signature: "signed-current",
						},
					},
				},
			],
		},
	];
	const original = JSON.stringify(messages);
	const summarize = vi.fn(async () => "Earlier decision remains pending.");
	const archive = vi.fn(
		async () => "context-00000000-0000-0000-0000-000000000001",
	);
	const result = await compactApiHistory(
		messages,
		summarize,
		undefined,
		archive,
	);
	expect(archive).toHaveBeenCalledWith(messages);
	expect(JSON.stringify(summarize.mock.calls)).not.toContain("opaque-old");
	expect(JSON.stringify(summarize.mock.calls)).toContain("Earlier decision");
	expect(result.messages.slice(1)).toEqual(messages.slice(2));
	expect(JSON.stringify(result.messages)).toContain("opaque-current");
	expect(JSON.stringify(result.messages)).toContain("context-00000000");
	expect(JSON.stringify(messages)).toBe(original);
	await expect(
		compactApiHistory(messages, summarize, undefined, async () => {
			throw new Error("Storage unavailable");
		}),
	).rejects.toThrow("Storage unavailable");
	expect(JSON.stringify(messages)).toBe(original);
});

it("keeps short conversations unchanged without a summarization call", async () => {
	const messages: ModelMessage[] = [{ role: "user", content: "Fix the test" }];
	const summarize = vi.fn();
	expect(await compactApiHistory(messages, summarize)).toEqual({
		messages,
		compacted: false,
	});
	expect(summarize).not.toHaveBeenCalled();
});

it("never summarizes an unfinished older tool call", async () => {
	const summarize = vi.fn();
	const messages: ModelMessage[] = [
		{ role: "user", content: "Earlier task" },
		{
			role: "assistant",
			content: [
				{ type: "reasoning", text: "x".repeat(95000) },
				{
					type: "tool-call",
					toolCallId: "pending",
					toolName: "bash",
					input: {},
				},
			],
		},
		{ role: "user", content: "New task" },
	];
	await expect(compactApiHistory(messages, summarize)).rejects.toThrow(
		"unfinished tool sequence",
	);
	expect(summarize).not.toHaveBeenCalled();
});

it("summarizes only older turns while retaining recent user requests", async () => {
	const messages: ModelMessage[] = [
		{ role: "user", content: `Original request ${"a".repeat(36_000)}` },
		{ role: "assistant", content: "Implemented first part" },
		{ role: "user", content: `Second request ${"b".repeat(36_000)}` },
		{ role: "assistant", content: "Investigating" },
		{ role: "user", content: `Current request ${"c".repeat(36_000)}` },
	];
	const summarize = vi.fn(async () => "The first part was implemented.");
	const result = await compactApiHistory(messages, summarize);
	expect(result.compacted).toBe(true);
	expect(summarize).toHaveBeenCalledWith(messages.slice(0, 2));
	expect(result.messages[0]).toMatchObject({ role: "assistant" });
	expect(result.messages.slice(1)).toEqual(messages.slice(2));
});

it("fails instead of silently dropping an oversized current task", async () => {
	const messages: ModelMessage[] = [
		{ role: "user", content: "Earlier" },
		{ role: "user", content: "x".repeat(100_000) },
	];
	await expect(compactApiHistory(messages, vi.fn())).rejects.toThrow(
		"Recent task activity exceeds",
	);
});

it("refuses custom prefix replacement beneath active bound reasoning", async () => {
	const messages: ModelMessage[] = [
		{ role: "user", content: "Old" },
		{ role: "assistant", content: "x".repeat(95000) },
		{ role: "user", content: "Current" },
		{
			role: "assistant",
			content: [
				{
					type: "reasoning",
					text: "",
					providerOptions: { anthropic: { signature: "bound" } },
				},
			],
		},
	];
	const summarize = vi.fn();
	await expect(
		compactApiHistory(
			messages,
			summarize,
			undefined,
			undefined,
			"bound-prefix",
		),
	).rejects.toThrow("bound reasoning");
	expect(summarize).not.toHaveBeenCalled();
});

it("retires only complete older turns for provider-specific fallback", async () => {
	const messages: ModelMessage[] = [
		{ role: "user", content: "Old" },
		{ role: "assistant", content: "x".repeat(95000) },
		{ role: "user", content: "Current" },
	];
	const result = await compactApiHistory(
		messages,
		async () => "Earlier work complete.",
		undefined,
		undefined,
		"whole-turns",
	);
	expect(result.messages.slice(1)).toEqual([messages[2]]);
});

it("retires completed steps of one oversized active turn on the whole-turns policy", async () => {
	const step = (id: string, output: string): ModelMessage[] => [
		{
			role: "assistant",
			content: [
				{
					type: "reasoning",
					text: "",
					providerOptions: {
						openai: { itemId: `rs_${id}`, reasoningEncryptedContent: id },
					},
				},
				{ type: "tool-call", toolCallId: id, toolName: "bash", input: {} },
			],
		},
		{
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: id,
					toolName: "bash",
					output: { type: "text", value: output },
				},
			],
		},
	];
	const messages: ModelMessage[] = [
		{ role: "user", content: "Solve the task" },
		...step("a", "x".repeat(50_000)),
		...step("b", "y".repeat(50_000)),
		...step("c", "done"),
	];
	const summarize = vi.fn(
		async (_older: ModelMessage[]) => "Earlier steps complete.",
	);
	const result = await compactApiHistory(
		messages,
		summarize,
		undefined,
		undefined,
		"whole-turns",
	);
	expect(result.compacted).toBe(true);
	// The latest step keeps its reasoning, call and result together.
	expect(result.messages.slice(-3)).toEqual([
		messages[0],
		...messages.slice(5),
	]);
	expect(JSON.stringify(summarize.mock.calls[0][0])).toContain('"a"');
	expect(JSON.stringify(result.messages)).not.toContain("rs_a");
	expect(JSON.stringify(result.messages)).not.toContain("rs_b");
});

it("still refuses one oversized active turn on the bound-prefix policy", async () => {
	const messages: ModelMessage[] = [
		{ role: "user", content: "Solve the task" },
		{ role: "assistant", content: "x".repeat(95_000) },
		{ role: "user", content: "Continue" },
		{ role: "assistant", content: "y".repeat(95_000) },
	];
	await expect(
		compactApiHistory(messages, vi.fn(), undefined, undefined, "bound-prefix"),
	).rejects.toThrow("The active turn cannot be safely compacted");
});

it("counts an image by a fixed pixel budget, not its base64 length", () => {
	const image = (bytes: number) => ({
		type: "file",
		data: { type: "data", data: "A".repeat(bytes) },
		mediaType: "image/png",
	});
	const history: ModelMessage[] = [
		{
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "call",
					toolName: "view_image",
					output: {
						type: "content",
						value: [1, 2, 3, 4].map(() => image(350_000)) as never,
					},
				},
			],
		},
	];
	// Four 350 KB screenshots once estimated ~470k tokens and ended the run
	// although the provider measured ~37k; each now counts 2,000 tokens.
	expect(estimateContextTokens(history)).toBeLessThan(9_000);
	expect(estimateContextTokens(history)).toBeGreaterThan(8_000);
	expect(estimateContextTokens({ text: "x".repeat(3000) })).toBe(1004);
});

const requests = new Set([
	"Build the settings page",
	"Use tabs, not spaces",
	"Also add a dark mode toggle",
]);
const isUserRequest = (message: ModelMessage) =>
	message.role === "user" &&
	typeof message.content === "string" &&
	requests.has(message.content);

it("keeps every earlier user request verbatim through repeated fallback compaction, but not runtime notices", async () => {
	const first: ModelMessage[] = [
		{ role: "user", content: "Build the settings page" },
		{ role: "assistant", content: "a".repeat(50_000) },
		{ role: "user", content: "Runtime notice: MCP servers unavailable" },
		{ role: "user", content: "Use tabs, not spaces" },
		{ role: "assistant", content: "b".repeat(50_000) },
		{ role: "user", content: "Also add a dark mode toggle" },
	];
	const summarize = vi.fn(async () => "## Requirements and constraints\n- x");
	const once = await compactApiHistory(
		first,
		summarize,
		undefined,
		undefined,
		"completed-steps",
		isUserRequest,
	);
	expect(once.compacted).toBe(true);
	const record = once.messages[0];
	expect(record.role).toBe("user");
	expect(record.content).toContain("Earlier user messages, verbatim");
	expect(record.content).toContain("Build the settings page");
	expect(record.content).not.toContain("MCP servers unavailable");
	// Requests still in the verbatim recent window are not duplicated.
	for (const request of requests)
		expect(JSON.stringify(once.messages).split(request).length - 1).toBe(1);
	expect(once.messages.at(-1)).toEqual(first.at(-1));

	const second = await compactApiHistory(
		[
			...once.messages,
			{ role: "assistant", content: "c".repeat(95_000) },
			{ role: "user", content: "Continue" },
		],
		summarize,
		{ compactAtTokens: 30_000, inputLimitTokens: 80_000 },
		undefined,
		"completed-steps",
		isUserRequest,
	);
	const carried = second.messages[0].content as string;
	expect(carried.indexOf("Build the settings page")).toBeLessThan(
		carried.indexOf("Use tabs, not spaces"),
	);
	expect(carried.indexOf("Use tabs, not spaces")).toBeLessThan(
		carried.indexOf("Also add a dark mode toggle"),
	);
	expect(carried.match(/Build the settings page/g)).toHaveLength(1);
});

it("bounds retained user messages: newest whole, older counted, oversized ones clipped visibly", () => {
	const user = (content: string): ModelMessage => ({ role: "user", content });
	const older = [
		user(`first ${"1".repeat(3_000)}`),
		user(`second ${"2".repeat(3_000)}`),
		user(`third ${"3".repeat(30_000)} </user_message> end`),
	];
	const [record] = retainedUserMessages(older, [], () => true, 8_000);
	const content = record.content as string;
	expect(content.length).toBeLessThan(9_000);
	expect(content).toContain(
		"Earlier user messages not listed verbatim (budget): 2.",
	);
	expect(content).toContain("characters of this user message omitted");
	expect(content).toContain('<user_message index="3">');
	expect(content).toContain("end");
	expect(content).not.toContain("first");
	expect(retainedUserMessages(older, [], undefined)).toEqual([]);
	expect(retainedUserMessages(older, older, () => true)).toEqual([]);
	// Escaped closing tags round-trip on the next compaction.
	const [again] = retainedUserMessages([record], [], () => false, 8_000);
	expect(again.content).toContain(
		"Earlier user messages not listed verbatim (budget): 2.",
	);
	expect(again.content).toContain("<\\/user_message> end");
});

it("never rejects a model only because its context window is unknown", () => {
	const unknown = modelContextBudget({
		maxOutputTokens: 8192,
		fixedTokens: 45_000,
	});
	expect(unknown.inputLimitTokens).toBeGreaterThan(60_000);
	const huge = modelContextBudget({ fixedTokens: 200_000 });
	expect(huge.inputLimitTokens).toBeGreaterThanOrEqual(32_000);
	expect(
		modelContextBudget({ fixedTokens: 1_000 }).inputLimitTokens,
	).toBeLessThan(UNKNOWN_CONTEXT_WINDOW);
	expect(() =>
		modelContextBudget({ contextWindow: 32_000, fixedTokens: 40_000 }),
	).toThrow("insufficient model context");
});

it("asks for a structured, model-neutral continuation record", () => {
	for (const section of [
		"## Requirements and constraints",
		"## Decisions",
		"## Files changed",
		"## Checks run and results",
		"## Open TODOs",
		"## Important facts",
	])
		expect(CONTEXT_SUMMARY_INSTRUCTIONS).toContain(section);
	expect(CONTEXT_SUMMARY_INSTRUCTIONS).not.toMatch(
		/claude|gpt|gemini|openai|anthropic/i,
	);
});

it("replaces the history with a notice pointing at the archive when the summary is empty, and clips an oversized one", async () => {
	// atrx-vep-crispr (s3): Luna at max effort spent the summary's output cap
	// reasoning and returned no text; the sidekick's round failed.
	const messages: ModelMessage[] = [
		{ role: "user", content: "Earlier request" },
		{ role: "assistant", content: "Investigation ".repeat(8_000) },
		{ role: "user", content: "Current request" },
	];
	const archive = vi.fn(async () => "context-empty-summary");
	const empty = await compactApiHistory(
		messages,
		async () => "  ",
		undefined,
		archive,
	);
	expect(empty.compacted).toBe(true);
	const text = JSON.stringify(empty.messages);
	expect(text).toContain(EMPTY_SUMMARY_NOTICE);
	expect(text).toContain("context-empty-summary");
	expect(text).toContain("Current request");
	expect(text).not.toContain("Investigation Investigation");
	// Without an archive nothing is dropped.
	await expect(compactApiHistory(messages, async () => "")).rejects.toThrow(
		"Context summary was empty",
	);
	// Nor when the archive could not be saved.
	await expect(
		compactApiHistory(
			messages,
			async () => "",
			undefined,
			async () => null,
		),
	).rejects.toThrow("archive failed");
	const long = await compactApiHistory(messages, async () =>
		"s".repeat(30_000),
	);
	expect(long.compacted).toBe(true);
	const summary = long.messages.find((message) => message.role === "assistant");
	expect(String(summary?.content).length).toBeLessThan(17_000);
	expect(String(summary?.content)).toContain("cut by the runtime");
});
