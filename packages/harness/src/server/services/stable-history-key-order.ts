import type { ModelMessage } from "ai";

/**
 * The model history with every plain object's keys in one fixed order, so a
 * request serializes the same bytes whether its history is still in memory
 * or was read back from Postgres.
 *
 * Provider adapters serialize tool-call inputs and JSON tool results as they
 * enumerate (`arguments: JSON.stringify(input)`). A history saved to the
 * api_turn.messages jsonb column comes back with its keys re-sorted (jsonb
 * orders them by byte length, then bytewise), while the running step still
 * holds them in the order the model or tool produced. So the next turn's
 * first request, and any step after the chat's local copy was dropped, sent
 * the earlier tool calls and results with different bytes and missed the
 * provider's prompt cache from the first such call onward. Ordering keys the
 * way jsonb does makes both sides the same and leaves an already-loaded
 * history unchanged.
 *
 * Only plain objects are rebuilt; arrays keep their order and other values
 * (strings, byte arrays, URLs) are returned as they are.
 */
export function stableHistoryKeyOrder(
	messages: readonly ModelMessage[],
): ModelMessage[] {
	return messages.map((message) => ordered(message) as ModelMessage);
}

function ordered(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(ordered);
	if (!isPlainObject(value)) return value;
	return Object.fromEntries(
		Object.keys(value)
			.sort(jsonbKeyOrder)
			.map((key) => [key, ordered(value[key])]),
	);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object") return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

const encoder = new TextEncoder();

/** Postgres jsonb: shorter keys first (in UTF-8 bytes), then bytewise. */
function jsonbKeyOrder(left: string, right: string) {
	const a = encoder.encode(left);
	const b = encoder.encode(right);
	if (a.length !== b.length) return a.length - b.length;
	for (let index = 0; index < a.length; index++)
		if (a[index] !== b[index]) return a[index] - b[index];
	return 0;
}
