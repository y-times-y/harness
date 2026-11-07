import {
	type JsonObject,
	linesBackward,
	linesForward,
	parseJsonObject,
} from "./io.ts";
import type { ToolCall, Turn } from "./types.ts";

/** Extra content read past the budget, so trimToBudget has dropped turns to digest. */
const BUDGET_SLACK_RATIO = 0.25;
/** After the budget is met, keep reading back at most this much to start at a user turn. */
const TURN_ALIGNMENT_LIMIT_CHARS = 400_000;

export interface TranscriptScan {
	/** Cheap string check run before JSON.parse; return false to skip the line unparsed. */
	mayBeRelevant(line: string): boolean;
	/** Cheap string check for lines that can hold a tool call or tool result. */
	mayHoldToolActivity(line: string): boolean;
	/** Approximate characters of turn content the record contributes. */
	contentChars(record: JsonObject): number;
	/** A record that starts a human turn; budgeted reads try to stop just before one. */
	startsUserTurn(record: JsonObject): boolean;
	/** Cheap string check for lines that can be a source compaction summary. */
	mayBeCompactionSummary(line: string): boolean;
	/** A source compaction summary: a budgeted backward read stops after including it. */
	isCompactionSummary(record: JsonObject): boolean;
}

export type TranscriptReadMode =
	/** Every relevant record, streamed forward. */
	| { kind: "full" }
	/** Only the newest records that fill the budget, read backwards from the end. */
	| { kind: "tail"; budgetChars: number }
	/** Only tool call / result records over the whole file, streamed forward. */
	| { kind: "activity" };

export interface TranscriptVisitResult {
	readFromStart: boolean;
	parseErrors: number;
}

/**
 * Visits parsed records in file order. Forward modes stream and never hold more
 * than one record; the tail mode holds only the records inside the budget and
 * stops at a compaction summary, or once the budget (plus slack) is filled and a
 * user-turn boundary is reached.
 */
export function visitTranscriptRecords(
	file: string,
	scan: TranscriptScan,
	mode: TranscriptReadMode,
	visit: (record: JsonObject) => void,
): TranscriptVisitResult {
	let parseErrors = 0;
	if (mode.kind !== "tail") {
		const keep =
			mode.kind === "activity" ? scan.mayHoldToolActivity : scan.mayBeRelevant;
		for (const line of linesForward(file)) {
			if (!keep(line)) continue;
			const record = parseJsonObject(line);
			if (record) visit(record);
			else parseErrors++;
		}
		return { readFromStart: true, parseErrors };
	}

	const target = mode.budgetChars * (1 + BUDGET_SLACK_RATIO);
	const reversed: JsonObject[] = [];
	let collected = 0;
	let readFromStart = true;
	let reachedCompaction = false;
	const lines = linesBackward(file);
	// Manual iteration: a for-of `break` would close the generator, and the
	// summary scan below continues from where the budgeted read stopped.
	for (let next = lines.next(); !next.done; next = lines.next()) {
		const line = next.value;
		if (!scan.mayBeRelevant(line)) continue;
		const record = parseJsonObject(line);
		if (!record) {
			parseErrors++;
			continue;
		}
		reversed.push(record);
		collected += scan.contentChars(record);
		if (scan.isCompactionSummary(record)) {
			readFromStart = false;
			reachedCompaction = true;
			break;
		}
		const budgetMet = collected >= target;
		const aligned =
			scan.startsUserTurn(record) ||
			collected >= target + TURN_ALIGNMENT_LIMIT_CHARS;
		if (budgetMet && aligned) {
			readFromStart = false;
			break;
		}
	}
	// The budget ran out before a compaction summary: keep scanning back, without
	// parsing, for the newest one so the older context it covers is not lost.
	let olderSummary: JsonObject | undefined;
	if (!readFromStart && !reachedCompaction) {
		for (let next = lines.next(); !next.done; next = lines.next()) {
			const line = next.value;
			if (!scan.mayBeCompactionSummary(line)) continue;
			const record = parseJsonObject(line);
			if (record && scan.isCompactionSummary(record)) {
				olderSummary = record;
				break;
			}
		}
	}
	lines.return(undefined);
	if (olderSummary) visit(olderSummary);
	for (let index = reversed.length - 1; index >= 0; index--)
		visit(reversed[index] as JsonObject);
	return { readFromStart, parseErrors };
}

export function transcriptReadMode(options: {
	budgetChars?: number;
	activityOnly?: boolean;
}): TranscriptReadMode {
	if (options.activityOnly) return { kind: "activity" };
	if (options.budgetChars !== undefined)
		return { kind: "tail", budgetChars: options.budgetChars };
	return { kind: "full" };
}

/**
 * Accumulates normalized turns. Assistant text and tool calls collect into one
 * assistant turn until the next human message; tool results attach by call id.
 */
export class TurnAssembler {
	private readonly turns: Turn[] = [];
	private assistant: Turn | undefined;
	private readonly callsById = new Map<string, ToolCall>();

	/**
	 * In activity-only mode text is ignored and tool inputs/outputs are released
	 * once a result is applied, so a whole-file pass keeps only commands and paths.
	 */
	constructor(private readonly activityOnly = false) {}

	addUserText(text: string, at?: string): void {
		const trimmed = text.trim();
		if (!trimmed || this.activityOnly) return;
		this.closeAssistant();
		const last = this.turns.at(-1);
		if (last && last.role === "user" && !last.synthetic) {
			last.text = `${last.text}\n\n${trimmed}`;
			return;
		}
		this.turns.push({ role: "user", text: trimmed, at, toolCalls: [] });
	}

	addCompactionSummary(text: string, at?: string): void {
		const trimmed = text.trim();
		if (!trimmed || this.activityOnly) return;
		this.closeAssistant();
		this.turns.push({
			role: "user",
			text: trimmed,
			at,
			toolCalls: [],
			synthetic: "compaction-summary",
		});
	}

	addAssistantText(text: string, at?: string): void {
		const trimmed = text.trim();
		if (!trimmed || this.activityOnly) return;
		const turn = this.openAssistant(at);
		turn.text = turn.text ? `${turn.text}\n\n${trimmed}` : trimmed;
	}

	addToolCall(call: ToolCall, callId?: string, at?: string): void {
		if (this.activityOnly) call.input = "";
		this.openAssistant(at).toolCalls.push(call);
		if (callId) this.callsById.set(callId, call);
	}

	/** Call after a result (output, exit code) has been applied to a call. */
	resultApplied(call: ToolCall): void {
		if (this.activityOnly) call.output = undefined;
	}

	/** The call a result refers to; undefined when the call was before the read window. */
	toolCall(callId: string | undefined): ToolCall | undefined {
		return callId === undefined ? undefined : this.callsById.get(callId);
	}

	finish(): Turn[] {
		this.closeAssistant();
		return this.turns;
	}

	private openAssistant(at?: string): Turn {
		if (!this.assistant) {
			this.assistant = { role: "assistant", text: "", at, toolCalls: [] };
		}
		return this.assistant;
	}

	private closeAssistant(): void {
		const turn = this.assistant;
		this.assistant = undefined;
		if (turn && (turn.text || turn.toolCalls.length > 0)) this.turns.push(turn);
	}
}

const NON_CONTENT_KEYS = new Set([
	"data",
	"signature",
	"thinking",
	"thinkingSignature",
	"encrypted_content",
	"image_url",
	"usage",
	"base_instructions",
]);

/** Sum of string leaf lengths, skipping binary and reasoning fields; a cheap budget estimate. */
export function approximateTextChars(
	value: unknown,
	cap = Number.POSITIVE_INFINITY,
): number {
	let total = 0;
	const visit = (node: unknown): void => {
		if (total >= cap) return;
		if (typeof node === "string") {
			total += node.length;
		} else if (Array.isArray(node)) {
			for (const item of node) visit(item);
		} else if (node && typeof node === "object") {
			for (const [key, child] of Object.entries(node))
				if (!NON_CONTENT_KEYS.has(key)) visit(child);
		}
	};
	visit(value);
	return Math.min(total, cap);
}

export function titleFromPrompt(
	prompt: string | undefined,
	maxChars = 80,
): string | undefined {
	if (!prompt) return undefined;
	const collapsed = prompt.replace(/\s+/g, " ").trim();
	if (collapsed.length <= maxChars) return collapsed;
	const cut = collapsed.slice(0, maxChars);
	const lastSpace = cut.lastIndexOf(" ");
	return `${(lastSpace > maxChars / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
