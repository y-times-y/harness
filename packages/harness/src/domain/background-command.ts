import { KIND_TAGS } from "./helper-names";
import { SessionItemId } from "./ids";
import type { SessionItem } from "./session-item";

/**
 * Background commands: shell commands an agent started with its command
 * tool's background option. They outlive the agent's step and turn, run until
 * they exit, the agent or the user stops them, the chat's machine stops, or
 * the safety cap (lean-engine.ts) ends them; the agent that started one gets
 * a notice when it exits (background-command-notices.ts).
 */

/** What a background command's card records (DynamicToolCallItem.background). */
export type BackgroundCommandRecord = {
	readonly id: string;
	/** A short label derived from the command (backgroundCommandLabel). */
	readonly label: string;
	/** Epoch ms. */
	readonly startedAt: number;
	/** Set once it exited: its exit status, or "interrupted" when none was recorded. */
	readonly exitCode?: number | "interrupted";
	/** Epoch ms; set with exitCode. */
	readonly endedAt?: number;
};

export type BackgroundCommandStatus = "running" | "exited" | "failed";

const LABEL_MAX_CHARACTERS = 60;

/** A short label for a command: its first meaningful line, without a leading `cd … &&`. */
export function backgroundCommandLabel(command: string): string {
	const line =
		command
			.split("\n")
			.map((part) => part.trim())
			.find((part) => part && !part.startsWith("#")) ?? "";
	const text = line
		.replace(/^(cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*)+/, "")
		.replace(/\s+/g, " ")
		.trim();
	if (!text) return "command";
	return text.length > LABEL_MAX_CHARACTERS
		? `${text.slice(0, LABEL_MAX_CHARACTERS - 1)}…`
		: text;
}

export function backgroundCommandStatus(
	record: BackgroundCommandRecord,
): BackgroundCommandStatus {
	if (record.exitCode === undefined) return "running";
	return record.exitCode === 0 ? "exited" : "failed";
}

/** "45s", "3m", "1h 5m". */
export function formatCommandDuration(milliseconds: number): string {
	const seconds = Math.max(0, Math.round(milliseconds / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
}

/** The card's live state: "running 3m", "exited 0", "failed (exit 2)", "interrupted". */
export function backgroundCommandStateText(
	record: BackgroundCommandRecord,
	now: number,
): string {
	if (record.exitCode === undefined)
		return `running ${formatCommandDuration(now - record.startedAt)}`;
	if (record.exitCode === "interrupted") return "interrupted";
	return record.exitCode === 0
		? "exited 0"
		: `failed (exit ${record.exitCode})`;
}

export type RunningBackgroundCommand = {
	readonly id: string;
	readonly label: string;
	readonly startedAt: number;
	readonly status: "running";
};

/**
 * The background commands a chat's timeline records as still running, oldest
 * first. Commands older than `maxSeconds` are past the safety cap and left out.
 */
export function runningBackgroundCommands(
	items: readonly SessionItem[],
	now: number,
	maxSeconds: number,
): RunningBackgroundCommand[] {
	const running = new Map<string, RunningBackgroundCommand>();
	for (const item of items) {
		if (item.kind !== "dynamicToolCall" || !item.background) continue;
		const record = item.background;
		if (record.exitCode !== undefined) {
			running.delete(record.id);
			continue;
		}
		if (now - record.startedAt > maxSeconds * 1000) continue;
		running.set(record.id, {
			id: record.id,
			label: record.label,
			startedAt: record.startedAt,
			status: "running",
		});
	}
	return [...running.values()].sort((a, b) => a.startedAt - b.startedAt);
}

/** Whether the timeline records a background command that has not exited yet. */
export function hasOpenBackgroundCommand(items: readonly SessionItem[]) {
	return items.some(
		(item) =>
			item.kind === "dynamicToolCall" &&
			item.background !== undefined &&
			item.background.exitCode === undefined,
	);
}

/** An exited background command as observed on the machine. */
export type BackgroundCommandExit = {
	readonly id: string;
	readonly label: string;
	readonly startedAt: number;
	readonly endedAt: number;
	readonly exitCode: number | "interrupted";
	readonly stopped?: "timeout" | "output_limit" | null;
	readonly outputPath: string;
	readonly lastLines: string;
};

const NOTICE_TAIL_CHARACTERS = 1200;

/** The notice the agent that started the command reads (bounded). */
export function backgroundCommandNotice(exit: BackgroundCommandExit): string {
	const status =
		exit.exitCode === "interrupted"
			? "was interrupted (no exit status)"
			: `finished with exit ${exit.exitCode}${exit.stopped === "timeout" ? " (stopped at its time limit)" : exit.stopped === "output_limit" ? " (stopped: output limit)" : ""}`;
	const tail = exit.lastLines.trim();
	const lastLines = tail
		? tail.length > NOTICE_TAIL_CHARACTERS
			? `…${tail.slice(-NOTICE_TAIL_CHARACTERS)}`
			: tail
		: "(no output)";
	return `Background command ${exit.id} (${exit.label}) ${status} after ${formatCommandDuration(exit.endedAt - exit.startedAt)}; output: ${exit.outputPath}; last lines:\n${lastLines}`;
}

/** The model message carrying one or more notices: runtime status, not a user request. */
export function backgroundCommandNoticeMessage(
	exits: readonly BackgroundCommandExit[],
): string {
	return `${exits.map(backgroundCommandNotice).join("\n\n")}\n\n(Runtime notice, not a new user request.)`;
}

/** The quiet timeline line for an exit. */
export function backgroundCommandNoticeLine(exit: {
	readonly label: string;
	readonly exitCode: number | "interrupted";
	readonly startedAt: number;
	readonly endedAt: number;
}): string {
	const how =
		exit.exitCode === "interrupted"
			? "was interrupted"
			: exit.exitCode === 0
				? "finished"
				: `failed (exit ${exit.exitCode})`;
	return `${KIND_TAGS.background}: ${exit.label} ${how} after ${formatCommandDuration(exit.endedAt - exit.startedAt)}`;
}

/**
 * Records exits on the cards that started those commands and appends a quiet
 * notice line for each exit that was `announced` (not stopped or waited on by
 * the agent itself). Returns the same array when nothing changed.
 */
export function withBackgroundCommandExits(
	items: readonly SessionItem[],
	exits: readonly (BackgroundCommandExit & { readonly announced: boolean })[],
): SessionItem[] {
	const byId = new Map(exits.map((exit) => [exit.id, exit]));
	let changed = false;
	const next: SessionItem[] = [];
	const notices: SessionItem[] = [];
	for (const item of items) {
		const exit =
			item.kind === "dynamicToolCall" && item.background
				? byId.get(item.background.id)
				: undefined;
		if (
			!exit ||
			item.kind !== "dynamicToolCall" ||
			!item.background ||
			item.background.exitCode !== undefined
		) {
			next.push(item);
			continue;
		}
		changed = true;
		next.push({
			...item,
			background: {
				...item.background,
				exitCode: exit.exitCode,
				endedAt: exit.endedAt,
			},
		});
		if (exit.announced)
			notices.push({
				kind: "notice",
				id: SessionItemId(`${item.id}:background-exit`),
				message: backgroundCommandNoticeLine(exit),
				background: true,
			});
	}
	return changed ? [...next, ...notices] : (items as SessionItem[]);
}
