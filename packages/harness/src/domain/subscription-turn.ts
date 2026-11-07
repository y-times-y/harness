/** Explicit transport identity: a deleted API connection must never become subscription billing. */
const prefix = "codex-subscription:v1:";

/**
 * `alternateContext` (the plan model's larger window) is written only when
 * chosen, so a standard-window turn keeps the revision it always had.
 */
export function subscriptionTurnRevision(
	reasoning?: string,
	fast = false,
	alternateContext = false,
) {
	return (
		prefix +
		JSON.stringify({
			reasoning,
			fast,
			...(alternateContext ? { alternateContext } : {}),
		})
	);
}

export function subscriptionTurnSettings(revision: string) {
	if (!revision.startsWith(prefix)) return null;
	const value = JSON.parse(revision.slice(prefix.length)) as {
		reasoning?: unknown;
		fast?: unknown;
		alternateContext?: unknown;
	};
	if (
		(value.reasoning !== undefined && typeof value.reasoning !== "string") ||
		typeof value.fast !== "boolean" ||
		(value.alternateContext !== undefined && value.alternateContext !== true)
	)
		throw new Error("Invalid subscription turn settings.");
	return {
		reasoning: value.reasoning as string | undefined,
		fast: value.fast,
		...(value.alternateContext === true
			? { alternateContext: true as const }
			: {}),
	};
}
