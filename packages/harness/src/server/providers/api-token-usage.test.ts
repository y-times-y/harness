import type { LanguageModelUsage } from "ai";
import { expect, it } from "vitest";
import { apiOutputTokenDetails, apiTokenUsage } from "./api-token-usage";

const usage: LanguageModelUsage = {
	inputTokens: 100,
	outputTokens: 10,
	totalTokens: 110,
	inputTokenDetails: {
		noCacheTokens: 100,
		cacheReadTokens: 0,
		cacheWriteTokens: undefined,
	},
	outputTokenDetails: { textTokens: 10, reasoningTokens: 0 },
};

it("preserves zero and missing output details while rejecting invalid counts", () => {
	expect(apiOutputTokenDetails(usage)).toEqual({
		textTokens: 10,
		reasoningTokens: 0,
	});
	for (const count of [undefined, -1, Number.NaN, 1.5])
		expect(
			apiOutputTokenDetails({
				...usage,
				outputTokenDetails: { textTokens: count, reasoningTokens: count },
			}),
		).toEqual({ textTokens: null, reasoningTokens: null });
});

it("preserves gateway cache-write accounting from raw SDK usage", () => {
	expect(
		apiTokenUsage({
			...usage,
			raw: {
				prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 20 },
			},
		}),
	).toEqual({
		inputTokens: 100,
		outputTokens: 10,
		uncachedInputTokens: 20,
		cacheReadTokens: 60,
		cacheWriteTokens: 20,
	});
});

it("reads DeepSeek's native hit/miss fields rather than generic SDK defaults", () => {
	expect(
		apiTokenUsage({
			...usage,
			raw: { prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20 },
		}),
	).toMatchObject({
		cacheReadTokens: 80,
		uncachedInputTokens: 20,
		cacheWriteTokens: null,
	});
});

it("preserves unknown values and rejects malformed token counts", () => {
	expect(
		apiTokenUsage({
			...usage,
			inputTokens: undefined,
			inputTokenDetails: {
				noCacheTokens: undefined,
				cacheReadTokens: undefined,
				cacheWriteTokens: undefined,
			},
			raw: { prompt_cache_hit_tokens: -1, prompt_cache_miss_tokens: "secret" },
		}),
	).toMatchObject({
		inputTokens: null,
		uncachedInputTokens: null,
		cacheReadTokens: null,
		cacheWriteTokens: null,
	});
});

it("does not classify unreported gateway cache writes as ordinary input", () => {
	expect(
		apiTokenUsage({
			...usage,
			raw: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 80 } },
		}),
	).toMatchObject({
		cacheReadTokens: 80,
		cacheWriteTokens: null,
		uncachedInputTokens: null,
	});
});

it("keeps the dollars OpenRouter reports and ignores invalid ones", () => {
	expect(apiTokenUsage({ ...usage, raw: { cost: 0.0123 } }).costUsd).toBe(
		0.0123,
	);
	expect(apiTokenUsage({ ...usage, raw: { cost: -1 } })).not.toHaveProperty(
		"costUsd",
	);
	expect(apiTokenUsage({ ...usage, raw: { cost: "1" } })).not.toHaveProperty(
		"costUsd",
	);
	expect(apiTokenUsage(usage)).not.toHaveProperty("costUsd");
});
