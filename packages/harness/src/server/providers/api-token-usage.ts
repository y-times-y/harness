import type { LanguageModelUsage } from "ai";
import type { ApiTokenUsage } from "../../domain/api-token-usage";

function tokenCount(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? value
		: null;
}

/** Missing provider details remain unknown, not zero or inferred from totals. */
export function apiOutputTokenDetails(usage: LanguageModelUsage) {
	return {
		textTokens: tokenCount(usage.outputTokenDetails.textTokens),
		reasoningTokens: tokenCount(usage.outputTokenDetails.reasoningTokens),
	};
}

export function apiTokenUsage(usage: LanguageModelUsage): ApiTokenUsage {
	const raw = usage.raw;
	const details = raw?.prompt_tokens_details;
	const detail: Record<string, unknown> =
		details && typeof details === "object" && !Array.isArray(details)
			? (details as Record<string, unknown>)
			: {};
	const inputTokens = tokenCount(usage.inputTokens);
	const cacheReadTokens =
		tokenCount(raw?.prompt_cache_hit_tokens) ??
		tokenCount(detail.cached_tokens) ??
		tokenCount(usage.inputTokenDetails.cacheReadTokens);
	const cacheWriteTokens =
		tokenCount(detail.cache_write_tokens) ??
		tokenCount(raw?.cache_creation_input_tokens) ??
		tokenCount(usage.inputTokenDetails.cacheWriteTokens);
	const uncachedInputTokens =
		tokenCount(raw?.prompt_cache_miss_tokens) ??
		(inputTokens !== null &&
		cacheReadTokens !== null &&
		cacheWriteTokens !== null
			? tokenCount(inputTokens - cacheReadTokens - cacheWriteTokens)
			: raw?.prompt_tokens !== undefined && cacheWriteTokens === null
				? null
				: tokenCount(usage.inputTokenDetails.noCacheTokens));
	// OpenRouter reports the request's dollars in its usage object.
	const cost = raw?.cost;
	return {
		inputTokens,
		outputTokens: tokenCount(usage.outputTokens),
		uncachedInputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		...(typeof cost === "number" && Number.isFinite(cost) && cost >= 0
			? { costUsd: cost }
			: {}),
	};
}
