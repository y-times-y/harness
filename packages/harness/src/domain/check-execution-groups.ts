/** Explicit groups override the shorthand, partition every command once, and finish in order. */
export function checkExecutionGroups(
	commandCount: number,
	groups?: readonly (readonly number[])[],
	parallel = false,
): number[][] {
	if (!groups)
		return parallel
			? [Array.from({ length: commandCount }, (_, index) => index)]
			: Array.from({ length: commandCount }, (_, index) => [index]);
	const indices = groups.flat();
	if (
		groups.some((group) => group.length < 1 || group.length > 2) ||
		indices.length !== commandCount ||
		new Set(indices).size !== commandCount ||
		indices.some(
			(index) => !Number.isInteger(index) || index < 0 || index >= commandCount,
		)
	)
		throw new Error(
			"Check groups must include every command exactly once, with at most two independent commands per group.",
		);
	return groups.map((group) => [...group]);
}
