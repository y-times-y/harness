/**
 * The parts of "Continue your agent session" the browser renders (no Node
 * APIs): agent names, the timeline's handoff card line and the import card's
 * status line. The server-side rules are in local-import.ts.
 */

export {
	LOCAL_AGENT_NAMES,
	LOCAL_AGENTS,
	type LocalAgent,
} from "../../../ytimesy-cli/src/local-agents.ts";

import {
	LOCAL_AGENT_NAMES,
	type LocalAgent,
} from "../../../ytimesy-cli/src/local-agents.ts";

export type ImportStatus =
	| "waiting"
	| "connected"
	| "importing"
	| "ready"
	| "failed";

/** "Oct 31": the same text on the server and in the browser (UTC). */
export function shortDay(iso: string) {
	const date = new Date(iso);
	return Number.isNaN(date.getTime())
		? iso.slice(0, 10)
		: date.toLocaleDateString("en-US", {
				month: "short",
				day: "numeric",
				timeZone: "UTC",
			});
}

/** The compact card's line: "Continued from <agent> · 42 turns · Oct 31". */
export function handoffCardLabel(input: {
	readonly tool: LocalAgent;
	readonly turns: number;
	readonly at: string;
}) {
	return `Continued from ${LOCAL_AGENT_NAMES[input.tool] ?? input.tool} · ${input.turns} ${input.turns === 1 ? "turn" : "turns"} · ${shortDay(input.at)}`;
}

/** The summary card's footer: "221 turns · Nov 1 · main". */
export function handoffCardMeta(input: {
	readonly turns: number;
	readonly at: string;
	readonly branch?: string | null;
}) {
	return [
		`${input.turns} ${input.turns === 1 ? "turn" : "turns"}`,
		shortDay(input.at),
		input.branch || null,
	]
		.filter(Boolean)
		.join(" · ");
}

export type LocalImportView = {
	readonly id: string;
	readonly status: ImportStatus | "expired";
	/** The local agent that started it (from the CLI's start call), when known. */
	readonly agent?: LocalAgent | null;
	readonly sessionsPlanned: number;
	readonly sessionsImported: number;
	readonly projectId: string | null;
	readonly sessionId: string | null;
	readonly message: string | null;
};

/** Settings > Import: one finished import and its chat. */
export type FinishedImportView = {
	readonly id: string;
	readonly finishedAt: string;
	readonly agent: LocalAgent | null;
	readonly sessions: number;
	readonly projectId: string;
	readonly projectName: string;
	readonly sessionId: string | null;
};

/** The import card's one status line. */
export function localImportStatusLine(view: LocalImportView) {
	switch (view.status) {
		case "waiting":
			return "Waiting for your agent…";
		case "expired":
			return "Code expired. Copy a new prompt.";
		case "connected":
			return "Your agent is planning the import…";
		case "importing":
			return view.sessionsPlanned > 0
				? `Importing ${Math.min(view.sessionsImported, view.sessionsPlanned)} of ${view.sessionsPlanned} sessions…`
				: `Importing ${view.sessionsImported} ${view.sessionsImported === 1 ? "session" : "sessions"}…`;
		case "ready":
			return "Ready";
		case "failed":
			return view.message ?? "Import failed. Copy a new prompt.";
	}
}

/** Whether the card stops polling: nothing more will change. */
export function localImportSettled(status: LocalImportView["status"]) {
	return status === "ready" || status === "failed" || status === "expired";
}
