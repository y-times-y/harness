import { expect, it } from "vitest";
import { searchContextMessages } from "./context-history-search";

it("searches tool evidence and decisions without exposing opaque metadata", () => {
	const messages = [
		{
			role: "assistant" as const,
			content: [
				{
					type: "reasoning" as const,
					text: "Branch isolation is implemented in src/branches.ts",
					providerOptions: {
						openai: { reasoningEncryptedContent: "secret-ciphertext" },
					},
				},
				{
					type: "tool-call" as const,
					toolCallId: "one",
					toolName: "read_file",
					input: { path: "src/branches.ts" },
				},
			],
		},
	];
	expect(searchContextMessages(messages, "BRANCH isolation")).toEqual([
		expect.objectContaining({
			messageIndex: 0,
			excerpt: expect.stringContaining("implemented"),
		}),
	]);
	expect(searchContextMessages(messages, "read_file branches.ts")).toHaveLength(
		1,
	);
	expect(searchContextMessages(messages, "secret-ciphertext")).toEqual([]);
	expect(() => searchContextMessages(messages, "  ")).toThrow();
});

it("ranks phrases above complete and partial word matches", () => {
	const matches = searchContextMessages(
		[
			{ role: "user", content: "worker timeout" },
			{ role: "assistant", content: "Isolation protects the worker" },
			{ role: "assistant", content: "worker isolation is implemented" },
		],
		"worker isolation",
	);
	expect(matches.map((match) => match.messageIndex)).toEqual([2, 1, 0]);
	expect(matches[0].score).toBeGreaterThan(matches[1].score);
});

it("uses alternative queries without duplicates and returns bounded original neighbors", () => {
	const matches = searchContextMessages(
		[
			{ role: "user", content: "Why was this necessary?" },
			{
				role: "assistant",
				content: "Execution is separated from orchestration.",
			},
			{ role: "assistant", content: "x".repeat(1000) },
		],
		"worker isolation",
		["execution orchestration", "Execution is separated"],
	);
	expect(matches).toHaveLength(1);
	expect(matches[0].messageIndex).toBe(1);
	expect(matches[0].matchedQuery).toBe("Execution is separated");
	expect(matches[0].context.map((neighbor) => neighbor.messageIndex)).toEqual([
		0, 2,
	]);
	expect(matches[0].context[1].excerpt).toHaveLength(300);
	expect(() =>
		searchContextMessages([], "test", Array(5).fill("test")),
	).toThrow();
});

it("bounds excerpts around matches and retains original message pointers", () => {
	const matches = searchContextMessages(
		[{ role: "user", content: `${"a".repeat(4000)}needle${"b".repeat(4000)}` }],
		"needle",
	);
	expect(matches[0].excerpt).toHaveLength(1200);
	expect(matches[0].excerpt).toContain("needle");
	expect(matches[0].messageIndex).toBe(0);
});
