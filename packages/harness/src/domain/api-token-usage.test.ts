import { expect, it } from "vitest";
import { applyApiProgress } from "./api-progress";
import { addApiTokenUsage } from "./api-token-usage";
import { SessionItemId } from "./ids";

const usage = {
	inputTokens: 100,
	outputTokens: 10,
	uncachedInputTokens: 20,
	cacheReadTokens: 60,
	cacheWriteTokens: 20,
};
it("adds per-request usage without turning unknown accounting into zero", () => {
	expect(addApiTokenUsage(usage, usage)).toEqual({
		inputTokens: 200,
		outputTokens: 20,
		uncachedInputTokens: 40,
		cacheReadTokens: 120,
		cacheWriteTokens: 40,
	});
	expect(
		addApiTokenUsage(usage, { ...usage, cacheWriteTokens: null })
			.cacheWriteTokens,
	).toBeNull();
});
it("sums reported dollars only while every request reported them", () => {
	expect(addApiTokenUsage(usage, usage)).not.toHaveProperty("costUsd");
	expect(
		addApiTokenUsage({ ...usage, costUsd: 0.25 }, { ...usage, costUsd: 0.5 })
			.costUsd,
	).toBe(0.75);
	expect(
		addApiTokenUsage({ ...usage, costUsd: 0.25 }, usage).costUsd,
	).toBeNull();
	expect(
		addApiTokenUsage(usage, { ...usage, costUsd: 0.25 }).costUsd,
	).toBeNull();
});
it("persists cumulative usage on only the current prompt without adding transcript noise", () => {
	const items = [
		{
			kind: "userMessage" as const,
			id: SessionItemId("old"),
			text: "Earlier",
			apiUsage: usage,
		},
		{
			kind: "userMessage" as const,
			id: SessionItemId("current"),
			text: "Current",
		},
	];
	const next = applyApiProgress(items, "turn", {
		type: "usage",
		usage: { ...usage, inputTokens: 200 },
	});
	expect(next).toHaveLength(2);
	expect(next[0]).toBe(items[0]);
	expect(next[1]).toMatchObject({ apiUsage: { inputTokens: 200 } });
});
