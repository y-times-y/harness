import { SessionItemId } from "./ids";
import type { DynamicToolCallItem } from "./session-item";

/**
 * Code mode (harness variant codeMode=on|primary): one tool whose input is a
 * JavaScript program that calls the builder's other tools. These helpers are
 * shared by the server (what a run records) and the chat (one card listing
 * the program's inner calls).
 */
export const CODE_MODE_TOOL = "run_code";

/** One inner tool call as a run_code result records it. */
export type CodeModeCallLog = {
	readonly tool: string;
	/** The call's arguments as JSON, clipped. */
	readonly input: string;
	readonly status: "completed" | "failed" | "refused";
	readonly ms: number;
	/** When the call started, in ms after the program's first call started (absent in older records). */
	readonly at?: number;
	/** What the program received (or the error), clipped. */
	readonly output: string;
};

/**
 * The most inner calls of one program that ran at the same time (1 = one
 * after another), from each call's start and duration; null when the
 * record predates start times.
 */
export function codeModeConcurrency(
	calls: readonly CodeModeCallLog[],
): number | null {
	if (!calls.length) return 0;
	if (calls.some((call) => typeof call?.at !== "number")) return null;
	const edges = calls.flatMap((call) => [
		{ time: call.at as number, delta: 1 },
		// Ends sort before starts at the same instant: back-to-back is not overlap.
		{ time: (call.at as number) + Math.max(1, call.ms), delta: -1 },
	]);
	edges.sort(
		(left, right) => left.time - right.time || left.delta - right.delta,
	);
	let running = 0;
	let most = 0;
	for (const edge of edges) {
		running += edge.delta;
		most = Math.max(most, running);
	}
	return most;
}

/** What run_code returns (and the chat stores). */
export type CodeModeResult = {
	readonly ok: boolean;
	/** The program's return value as the model sees it, within the lean output limit. */
	readonly result?: string;
	readonly error?: string;
	readonly console?: string;
	readonly calls: readonly CodeModeCallLog[];
};

/** The chat stores tool output up to 16,000 characters; a run's record stays below it so it still parses. */
const STORED_CHARACTERS = 15_000;

const clipText = (text: string, limit: number) =>
	text.length > limit
		? `${text.slice(0, limit)}… [${text.length - limit} more characters]`
		: text;

/**
 * A run_code result bounded for the transcript: inner outputs, then inputs,
 * the console and the return value are shortened until the whole record fits.
 */
export function storedCodeModeResult(value: CodeModeResult): CodeModeResult {
	for (const limit of [2_000, 800, 300, 120, 40]) {
		const shortened: CodeModeResult = {
			...value,
			...(value.result !== undefined
				? { result: clipText(value.result, limit * 3) }
				: {}),
			...(value.console !== undefined
				? { console: clipText(value.console, limit) }
				: {}),
			calls: value.calls.map((call) => ({
				...call,
				input: clipText(call.input, limit),
				output: clipText(call.output, limit),
			})),
		};
		if (JSON.stringify(shortened, null, 2).length <= STORED_CHARACTERS)
			return shortened;
	}
	return {
		ok: value.ok,
		...(value.error ? { error: clipText(value.error, 400) } : {}),
		calls: value.calls.slice(0, 40).map((call) => ({
			...call,
			input: clipText(call.input, 40),
			output: "",
		})),
	};
}

function parsed(text: string | undefined): unknown {
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/** A run_code program, shown as code instead of its JSON envelope. */
export function codeModeProgram(item: DynamicToolCallItem): string | null {
	if (item.tool !== CODE_MODE_TOOL) return null;
	const input = parsed(item.input) as { code?: unknown } | null;
	return typeof input?.code === "string" ? input.code : null;
}

/** A stored run_code result, if the item is one and its record parses. */
export function codeModeResult(
	item: DynamicToolCallItem,
): CodeModeResult | null {
	if (item.tool !== CODE_MODE_TOOL) return null;
	let value = parsed(item.output) as Record<string, unknown> | null;
	if (value?.type === "json") value = value.value as Record<string, unknown>;
	if (!value || typeof value !== "object" || !Array.isArray(value.calls))
		return null;
	return value as unknown as CodeModeResult;
}

/** The program's inner calls as ordinary tool-call items, so the chat reuses its tool cards. */
export function codeModeCallItems(
	item: DynamicToolCallItem,
): DynamicToolCallItem[] {
	const result = codeModeResult(item);
	if (!result) return [];
	return result.calls.flatMap((call, index) =>
		call && typeof call === "object" && typeof call.tool === "string"
			? [
					{
						kind: "dynamicToolCall" as const,
						id: SessionItemId(`${item.id}:code:${index}`),
						tool: call.tool,
						input: typeof call.input === "string" ? call.input : undefined,
						output:
							typeof call.output === "string" && call.output
								? call.output
								: undefined,
						status: call.status === "completed" ? "completed" : "failed",
					},
				]
			: [],
	);
}
