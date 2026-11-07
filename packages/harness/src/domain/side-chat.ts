import { isInternalChildTaskMessage } from "./child-task-activity";
import type { SessionItem, SessionTurnStatus } from "./session-item";
import type { SubagentBudget } from "./subagent";

/**
 * A side chat is a child session of the open chat (parent_session_id set,
 * agent_role writer, task_placement shared) marked with this budget flag.
 * The flag keeps it out of the helper tree and out of parent reports: its
 * turns run on the parent's checkout, and they never join the parent's queue.
 */
export function isSideChat(session: {
	readonly agentBudget?: { readonly sideChat?: boolean } | null;
}) {
	return session.agentBudget?.sideChat === true;
}

/** A side turn started while Main's turn runs may read the checkout but not write it. */
export function sideChatReadOnly(
	parentTurnStatus: SessionTurnStatus | null | undefined,
) {
	return parentTurnStatus === "running";
}

/** Large enough that the helper budget guard is not what bounds a side chat. */
export function sideChatBudget(): SubagentBudget {
	return {
		sideChat: true,
		steps: 10_000,
		minutes: 24 * 60,
		tokens: 5_000_000,
	};
}

/**
 * Helpers the agent tool started. A side chat and anything under it are a
 * separate conversation, so they are not nodes in this tree.
 */
export function sessionsInSubagentTree<
	T extends {
		readonly id: string;
		readonly parentSessionId: string | null;
		readonly agentBudget?: { readonly sideChat?: boolean } | null;
	},
>(rootId: string, sessions: readonly T[]): T[] {
	const byId = new Map(sessions.map((session) => [session.id, session]));
	const hidden = (id: string) => {
		const seen = new Set<string>();
		let current = byId.get(id);
		while (current && !seen.has(current.id)) {
			if (isSideChat(current)) return true;
			seen.add(current.id);
			const parentId = current.parentSessionId;
			if (!parentId) return false;
			current = byId.get(parentId);
		}
		return false;
	};
	return sessions.filter(
		(session) => session.id === rootId || !hidden(session.id),
	);
}

/** /side is ready: it opens a column and does not wait for the running turn. */
export function slashCommandOpensSideChat(command: {
	readonly id: string;
	readonly availability: string;
}) {
	return command.id === "side" && command.availability === "ready";
}

/**
 * Where a side-chat send goes. The parent id is only a check that the send
 * cannot land on it; the queue, when the side turn is already running, is
 * the side session's own.
 */
export function sideChatSendTarget(input: {
	readonly parentSessionId: string;
	readonly sideSessionId: string;
	readonly sideTurnStatus: SessionTurnStatus;
}): {
	readonly sessionId: string;
	readonly queueOn: "side" | "none";
	readonly parent: "untouched";
} {
	if (input.sideSessionId === input.parentSessionId)
		throw new Error("A side chat cannot be the main chat.");
	return {
		sessionId: input.sideSessionId,
		queueOn: input.sideTurnStatus === "running" ? "side" : "none",
		parent: "untouched",
	};
}

const PARENT_CONTEXT_LIMIT = 8_000;
const LINE_LIMIT = 700;

/** Who the side agent is. It shares Main's checkout and does not publish it. */
export function sideChatInstructions() {
	return [
		"You are the coding agent in a side chat beside Main. You have the same tools, repository, and model as Main, and you answer the user in this side conversation.",
		"Main keeps working on its own turn. Never message Main, stop it, steer it, or put anything into its queue. A snapshot of Main's chat is included with the user's message so you can talk about the work in progress; verify anything you rely on against the checkout.",
		"You share Main's checkout. While Main is working, your tools are read-only: read files and run commands that do not write, and when the user asks for a change, describe it or offer to make it once Main finishes. When Main is idle you may change files. Never commit, push, reset, stash, or switch branches: Main publishes this checkout, and doing that yourself would interrupt its run.",
		"Answer the user directly. Ask only for a decision that is genuinely theirs.",
	].join(" ");
}

/** The main chat, as the side turn's own model input. It is not a parent message. */
export function sideChatModelText(
	userText: string,
	items: readonly SessionItem[],
) {
	return [
		"Main chat right now (context only; Main's turn is separate and you must not message or stop it):",
		sideChatParentContext(items),
		"",
		"The user says:",
		userText,
	].join("\n");
}

function sideChatParentContext(items: readonly SessionItem[]) {
	const lines: string[] = [];
	for (const item of items) {
		const line = parentContextLine(item);
		if (line) lines.push(line);
	}
	const body = lines.join("\n");
	if (!body) return "(The main chat has no messages yet.)";
	return body.length > PARENT_CONTEXT_LIMIT
		? body.slice(body.length - PARENT_CONTEXT_LIMIT)
		: body;
}

function parentContextLine(item: SessionItem): string | null {
	switch (item.kind) {
		case "userMessage":
			if (isInternalChildTaskMessage(item.text)) return null;
			return clip(`${item.queued ? "User (waiting)" : "User"}: ${item.text}`);
		case "agentMessage":
			return clip(`Main: ${item.text}`);
		case "commandExecution":
			return clip(
				`Main ran \`${item.command}\` (${item.status}${item.exitCode === null ? "" : `, exit ${item.exitCode}`}).`,
			);
		case "fileChange":
			return clip(
				`Main ${item.status} ${item.changes
					.slice(0, 8)
					.map((change) => change.path)
					.join(", ")}.`,
			);
		case "dynamicToolCall":
			return clip(`Main called ${item.tool} (${item.status}).`);
		case "mcpToolCall":
			return clip(`Main called ${item.server}/${item.tool} (${item.status}).`);
		case "webSearch":
			return item.query ? clip(`Main searched: ${item.query}`) : null;
		case "error":
			return clip(`Main hit an error: ${item.message}`);
		case "plan":
		case "planProposal":
			return clip(`Main's plan: ${item.text}`);
		default:
			return null;
	}
}

function clip(text: string) {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > LINE_LIMIT ? `${flat.slice(0, LINE_LIMIT)}…` : flat;
}
