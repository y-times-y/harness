import { applyApiProgress } from "./api-progress";
import { isWakeTurnStart, turnStartTiming } from "./child-task-activity";
import { SessionItemId } from "./ids";
import type { SessionItem, SessionTurnStatus } from "./session-item";
import { withoutSavingChanges } from "./turn-saving";

/** The quiet line that closes a turn the user stopped. */
export const STOPPED_NOTICE = "Stopped";

/** Older messages are never marked: they predate recorded turn ends. */
const MARK_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * A settled turn's transcript: its messages record when the turn ended (the
 * agents list stops Main's clock there and "Worked for" reads it). Every
 * delivered message since the last recorded end is marked.
 */
export function settledTurnItems(
	items: readonly SessionItem[],
	endedAt: number,
): SessionItem[] {
	// "Saving changes…" belongs to the running turn only.
	const next = withoutSavingChanges(items);
	for (let index = next.length - 1; index >= 0; index--) {
		const item = next[index];
		if (item?.kind !== "userMessage" || item.queued || !item.timing) continue;
		if (
			item.timing.completedAt !== undefined ||
			endedAt - item.timing.startedAt > MARK_WINDOW_MS
		)
			break;
		next[index] = {
			...item,
			timing: {
				...item.timing,
				completedAt: Math.max(item.timing.startedAt, endedAt),
			},
		};
	}
	return next;
}

/**
 * When a finished agent's last turn ended, as its transcript records it; null
 * for turns from before the end was recorded.
 */
export function lastTurnEnd(items: readonly SessionItem[]): number | null {
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		// A wake-up turn's start counts: Main's clock runs to its end.
		if (item && isWakeTurnStart(item))
			return turnStartTiming(item)?.completedAt ?? null;
		if (item?.kind === "userMessage" && !item.queued)
			return item.timing?.completedAt ?? null;
	}
	return null;
}

/** A turn the user stopped closes with a "Stopped" notice, once. */
export function withStoppedNotice(
	items: readonly SessionItem[],
	turnId: string,
): SessionItem[] {
	const id = SessionItemId(`${turnId}:stopped`);
	if (items.some((item) => item.id === id)) return [...items];
	return [
		...items,
		{ kind: "notice", id, message: STOPPED_NOTICE, stopped: true },
	];
}

/**
 * The open chat the moment the user presses Stop, before the server answers:
 * idle, its partial answer kept (no longer streaming) and closed with the
 * "Stopped" notice, as the server will settle it. The server's own view
 * replaces these items when it arrives.
 */
export function sessionStoppedByUser<
	View extends {
		readonly items: readonly SessionItem[];
		readonly turnStatus: SessionTurnStatus;
	},
>(view: View, now: number): View {
	if (view.turnStatus !== "running") return view;
	let lastUser: SessionItem | undefined;
	for (const item of view.items)
		if (item.kind === "userMessage" && !item.queued) lastUser = item;
	const finished = applyApiProgress(view.items, "", {
		type: "finish",
		inputTokens: null,
		outputTokens: null,
		reason: "stopped",
	});
	// Messages still waiting stay after the stopped turn, as the server lists them.
	const queued = finished.filter(
		(item) => item.kind === "userMessage" && item.queued,
	);
	const turn = finished.filter((item) => !queued.includes(item));
	return {
		...view,
		turnStatus: "idle",
		items: [
			...settledTurnItems(
				withStoppedNotice(turn, `stop:${lastUser?.id ?? "turn"}`),
				now,
			),
			...queued,
		],
	};
}
