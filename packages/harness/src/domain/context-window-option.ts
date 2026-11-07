/**
 * A second context window a route offers beside its standard one: a ChatGPT
 * plan model's larger `max_context_window`, or the cheaper price tier of an
 * API model whose maker charges more for long prompts. A model without one
 * never shows the option, so it is never offered where it would do nothing.
 */
export type ListedContextWindow = {
	/** The route's default window, in tokens: what a turn runs without a choice. */
	readonly standard: number;
	/** The window the user may choose instead (larger or smaller), in tokens. */
	readonly alternate: number;
	/** One short line on what the alternate window means for cost, from the maker's docs. */
	readonly note?: string;
};

/** A window as the picker shows it: 272K, 872K, 1M, 1.05M. */
export function contextWindowLabel(tokens: number): string {
	if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(2))}M`;
	return `${Math.round(tokens / 1000)}K`;
}

/** A listed window, kept only when it is real (a different window than the standard). */
export function listedContextWindow(
	value: unknown,
): ListedContextWindow | undefined {
	if (!value || typeof value !== "object") return undefined;
	const { standard, alternate, note } = value as Record<string, unknown>;
	if (
		typeof standard !== "number" ||
		typeof alternate !== "number" ||
		!Number.isSafeInteger(standard) ||
		!Number.isSafeInteger(alternate) ||
		standard <= 0 ||
		alternate <= 0 ||
		alternate === standard
	)
		return undefined;
	return {
		standard,
		alternate,
		...(typeof note === "string" && note ? { note } : {}),
	};
}

/** The window a turn runs with: the alternate one only when chosen and offered. */
export function chosenContextWindow(
	option: ListedContextWindow | undefined,
	alternateContext: boolean | undefined,
): number | undefined {
	if (!option) return undefined;
	return alternateContext ? option.alternate : option.standard;
}
