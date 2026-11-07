export type ApiTokenUsage = {
	inputTokens: number | null;
	outputTokens: number | null;
	uncachedInputTokens: number | null;
	cacheReadTokens: number | null;
	cacheWriteTokens: number | null;
	/**
	 * Dollars the provider itself reported (OpenRouter returns a cost per
	 * request). Absent when no request reported one; null when only some did.
	 */
	costUsd?: number | null;
	/** Model calls (requests) summed into this record; absent on older records. */
	requests?: number;
	/**
	 * The part of this usage from requests whose input exceeded
	 * `aboveInputTokens` (the model's long-context pricing threshold), so
	 * tiered prices apply per request. Absent when no request was that large
	 * or the model has no such tier.
	 */
	longContext?: LongContextUsage;
};

export type LongContextUsage = {
	aboveInputTokens: number;
	requests: number;
	inputTokens: number | null;
	outputTokens: number | null;
	uncachedInputTokens: number | null;
	cacheReadTokens: number | null;
	cacheWriteTokens: number | null;
};

const TOKEN_FIELDS = [
	"inputTokens",
	"outputTokens",
	"uncachedInputTokens",
	"cacheReadTokens",
	"cacheWriteTokens",
] as const;

function sumFields<T extends Record<(typeof TOKEN_FIELDS)[number], unknown>>(
	previous: T,
	next: T,
) {
	return Object.fromEntries(
		TOKEN_FIELDS.map((key) => [
			key,
			previous[key] === null ||
			next[key] === null ||
			previous[key] === undefined ||
			next[key] === undefined
				? null
				: (previous[key] as number) + (next[key] as number),
		]),
	) as Pick<ApiTokenUsage, (typeof TOKEN_FIELDS)[number]>;
}

function addLongContext(
	previous: LongContextUsage | undefined,
	next: LongContextUsage | undefined,
): LongContextUsage | undefined {
	if (!previous) return next;
	if (!next) return previous;
	// A different threshold (the route changed model mid-turn) keeps the first.
	if (previous.aboveInputTokens !== next.aboveInputTokens) return previous;
	return {
		...sumFields(previous, next),
		aboveInputTokens: previous.aboveInputTokens,
		requests: previous.requests + next.requests,
	};
}

/**
 * One model request's usage, tagged for tiered pricing: `requests: 1`, and
 * the whole request as `longContext` when its input exceeded the model's
 * long-context threshold.
 */
export function requestTokenUsage(
	usage: ApiTokenUsage,
	longContextAbove: number | null,
): ApiTokenUsage {
	const tagged: ApiTokenUsage = { ...usage, requests: 1 };
	if (
		longContextAbove === null ||
		usage.inputTokens === null ||
		usage.inputTokens <= longContextAbove
	)
		return tagged;
	return {
		...tagged,
		longContext: {
			aboveInputTokens: longContextAbove,
			requests: 1,
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
			uncachedInputTokens: usage.uncachedInputTokens,
			cacheReadTokens: usage.cacheReadTokens,
			cacheWriteTokens: usage.cacheWriteTokens,
		},
	};
}

export function addApiTokenUsage(
	previous: ApiTokenUsage | null,
	next: ApiTokenUsage,
): ApiTokenUsage {
	if (!previous) return next;
	let sum = sumFields(previous, next) as ApiTokenUsage;
	if (previous.requests !== undefined || next.requests !== undefined)
		sum = {
			...sum,
			requests: (previous.requests ?? 0) + (next.requests ?? 0),
		};
	const longContext = addLongContext(previous.longContext, next.longContext);
	if (longContext) sum = { ...sum, longContext };
	if (previous.costUsd === undefined && next.costUsd === undefined) return sum;
	return {
		...sum,
		costUsd:
			typeof previous.costUsd === "number" && typeof next.costUsd === "number"
				? previous.costUsd + next.costUsd
				: null,
	};
}
