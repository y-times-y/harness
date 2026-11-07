import { pendingPlanId } from "./agent-plan";
import type { AgentTodo } from "./agent-todos";
import type { ApiTokenUsage } from "./api-token-usage";
import type { BackgroundCommandRecord } from "./background-command";
import type { CodexUsage } from "./codex-usage";
import {
	ENVIRONMENT_SETUP_TITLE,
	isEnvironmentSetupPrompt,
} from "./environment-setup";
import type { HandoffFiles, HandoffSummary } from "./handoff-summary";
import { SessionItemId } from "./ids";
import type { LocalAgent } from "./local-import-view";
import type { MemoryRecall, SavedMemoryLine } from "./memory-marker";
import type { MessageAttachment } from "./message-attachment";
import type { FailoverReason } from "./model-failover";
import type { PushApprovalRequest, PushResult } from "./push-approval";
import { visibleRuntimeUserText } from "./runtime-handoff";
import type { RequestableSecretKind, RequestedSecret } from "./secret-request";
import {
	fileChangesFromShellCommand,
	remainingShellCommandAfterWrites,
} from "./shell-file-change";
import type { UserQuestion } from "./user-question";

export type SessionTurnStatus = "idle" | "running" | "completed" | "failed";

export type ToolActivityStatus =
	| "inProgress"
	| "completed"
	| "failed"
	| "declined";

export type UserMessageItem = {
	readonly contextUsage?: Pick<CodexUsage, "context" | "compacting">;
	readonly apiUsage?: ApiTokenUsage;
	readonly kind: "userMessage";
	readonly id: SessionItemId;
	readonly text: string;
	/** Files sent with the message; bytes stay in private storage. */
	readonly attachments?: readonly MessageAttachment[];
	/** The user approved the agent's proposed plan; edits are unlocked. */
	readonly approvesPlan?: true;
	/** Cross-chat memory read for this request; the model saw it as a separate part. */
	readonly memory?: MemoryRecall;
	/** Sent while a turn ran; it waits in this chat until Send or the turn's end. */
	readonly queued?: true;
	/** Send was pressed; the next model step takes it. Only set on a waiting message. */
	readonly released?: true;
	/**
	 * Waits for the project's environment (being set up, or failed): it goes
	 * by itself once the environment is ready. Only set on a waiting message.
	 */
	readonly heldForSetup?: true;
	readonly timing?: {
		readonly startedAt: number;
		readonly completedAt?: number;
	};
};

export type AgentMessageItem = {
	readonly kind: "agentMessage";
	readonly id: SessionItemId;
	readonly text: string;
	readonly streaming?: boolean;
	readonly phase?: "commentary" | "final_answer";
};

export type ReasoningItem = {
	readonly kind: "reasoning";
	readonly id: SessionItemId;
	readonly summaries: readonly string[];
	readonly durationSeconds?: number;
};

export type PlanItem = {
	readonly kind: "plan";
	readonly id: SessionItemId;
	readonly text: string;
	readonly todos?: readonly AgentTodo[];
};

/** A plan the agent proposed with propose_plan; the turn ended to wait for the user. */
export type PlanProposalItem = {
	readonly kind: "planProposal";
	readonly id: SessionItemId;
	readonly text: string;
};

/**
 * Project secrets the agent asked for with request_project_secret, in one
 * card; the turn ended to wait for the user. Chats from before the list
 * carry one name (read both with requestedSecrets).
 */
export type SecretRequestItem =
	| {
			readonly kind: "secretRequest";
			readonly id: SessionItemId;
			readonly secrets: readonly RequestedSecret[];
	  }
	| {
			readonly kind: "secretRequest";
			readonly id: SessionItemId;
			readonly name: string;
			readonly secretKind: RequestableSecretKind;
			readonly reason: string;
	  };

/**
 * A push to a repository's default branch the agent asked the user to approve
 * with request_push_approval; the turn ended to wait for Push or Cancel.
 */
export type PushApprovalItem = {
	readonly kind: "pushApproval";
	readonly id: SessionItemId;
} & PushApprovalRequest;

/** Questions the agent asked with ask_user; the turn ended to wait for the user's choice. */
export type UserQuestionItem = {
	readonly kind: "userQuestion";
	readonly id: SessionItemId;
	readonly questions: readonly UserQuestion[];
};

/** Memory lines this turn added: by the agent's own commits or the save hook after it. */
export type MemorySaveItem = {
	readonly kind: "memorySave";
	readonly id: SessionItemId;
	readonly lines: readonly SavedMemoryLine[];
};

export type CommandExecutionItem = {
	readonly kind: "commandExecution";
	readonly id: SessionItemId;
	readonly command: string;
	readonly cwd: string | null;
	readonly status: ToolActivityStatus;
	readonly output: string | null;
	readonly exitCode: number | null;
};

export type FileChangeEntry = {
	readonly path: string;
	readonly change: "add" | "delete" | "update";
	readonly additions: number;
	readonly deletions: number;
	readonly preview: string | null;
};

export type FileChangeItem = {
	readonly kind: "fileChange";
	readonly id: SessionItemId;
	readonly status: ToolActivityStatus;
	readonly changes: readonly FileChangeEntry[];
};

export type McpToolCallItem = {
	readonly kind: "mcpToolCall";
	readonly id: SessionItemId;
	readonly server: string;
	readonly tool: string;
	readonly status: Exclude<ToolActivityStatus, "declined">;
};

export type DynamicToolCallItem = {
	readonly kind: "dynamicToolCall";
	readonly id: SessionItemId;
	readonly tool: string;
	readonly input?: string;
	readonly output?: string;
	readonly status: Exclude<ToolActivityStatus, "declined">;
	/** Set when the call started a background command (background-command.ts). */
	readonly background?: BackgroundCommandRecord;
};

export type WebSearchItem = {
	readonly kind: "webSearch";
	readonly id: SessionItemId;
	readonly query: string | null;
};

export type ErrorSessionItem = {
	readonly kind: "error";
	readonly id: SessionItemId;
	readonly message: string;
	/** Why, for the owner: a machine failure's raw cause, redacted. Not shown in the chat. */
	readonly cause?: string;
};

/**
 * The turn moved to another model route because its own was unavailable, or
 * (awaiting approval) stopped before moving onto a paid API key.
 */
export type ModelSwitchItem = {
	readonly kind: "modelSwitch";
	readonly id: SessionItemId;
	readonly message: string;
	/** A failover's reason, or lead mode fusion's sidekick switching models at a compaction. */
	readonly reason: FailoverReason | "sidekick-escalation";
	readonly from: { readonly model: string; readonly connection: string };
	readonly to: {
		readonly model: string;
		readonly connection: string;
		/** The route's key (`<connection>|<model>`), sent back to continue on it. */
		readonly key: string;
	};
	readonly state: "switched" | "awaitingApproval";
	/** The failing route's error, redacted and at most 300 characters (not shown). */
	readonly cause?: string;
	/** The turn's usage before the switch; usage after it was served by `to`. */
	readonly usageBefore?: ApiTokenUsage;
	/** A usage-limit switch: when the ChatGPT plan said it resets (epoch ms). */
	readonly resetsAt?: number;
};

/** A server note about the turn, such as why its changes were not pushed to GitHub. */
export type NoticeSessionItem = {
	readonly kind: "notice";
	readonly id: SessionItemId;
	readonly message: string;
	/** A background command's exit (background-command.ts). */
	readonly background?: true;
	/** The user stopped the turn (turn-end.ts). */
	readonly stopped?: true;
	/**
	 * The silent start of a wake-up turn the server began (a helper's report,
	 * a background command's exit), standing in for its hidden message
	 * (childTaskPublicItems). It shows nothing; it ends the turn before it.
	 */
	readonly wake?: true;
	readonly timing?: UserMessageItem["timing"];
	/**
	 * The turn's pull request handoff (pull-request-handoff-item.ts): pushing
	 * and opening it continue after the turn shows as done, so the chat says
	 * so until GitHub answers, then links the pull request.
	 */
	readonly pullRequest?: PullRequestHandoffState;
	/** How a push approval card (request_push_approval) was answered. */
	readonly pushResult?: PushResult;
	/**
	 * The turn answered and is committing its changes ("Saving changes…",
	 * turn-saving.ts); removed before the turn is marked done.
	 */
	readonly savingChanges?: true;
};

export type PullRequestHandoffState =
	| {
			readonly state: "opening";
			/** When the handoff started (epoch ms); an old one is no longer shown. */
			readonly since: number;
	  }
	| {
			readonly state: "opened";
			readonly number: number;
			readonly url: string;
			readonly draft: boolean;
			/** Opened by this turn, not an open one it pushed to. */
			readonly created: boolean;
	  };

/**
 * The start of a chat continued from a local agent session ("Continue your
 * agent session"). The timeline shows one compact card; the model reads
 * `context` as prior conversation (api-conversation.ts).
 */
export type HandoffSessionItem = {
	readonly kind: "handoff";
	readonly id: SessionItemId;
	readonly tool: LocalAgent;
	readonly title: string;
	/** Turns in the local session. */
	readonly turns: number;
	/** The local session's last activity (ISO). */
	readonly at: string;
	/** The handoff as the model reads it (handoffContextText); never rendered. */
	readonly context: string;
	/** The ytimesy/... branch the CLI pushed (the chat's branch). */
	readonly branch?: string;
	/** The card's goal / where it stopped / next lines and its details (older chats have none). */
	readonly summary?: HandoffSummary;
	/** What the CLI pushed and left out, paths only and bounded. */
	readonly files?: HandoffFiles;
};

export type UnknownSessionItem = {
	readonly kind: "unknown";
	readonly id: SessionItemId;
	readonly type: string;
};

export type SessionItem =
	| UserMessageItem
	| AgentMessageItem
	| ReasoningItem
	| PlanItem
	| PlanProposalItem
	| SecretRequestItem
	| PushApprovalItem
	| UserQuestionItem
	| MemorySaveItem
	| CommandExecutionItem
	| FileChangeItem
	| McpToolCallItem
	| DynamicToolCallItem
	| WebSearchItem
	| ErrorSessionItem
	| ModelSwitchItem
	| NoticeSessionItem
	| HandoffSessionItem
	| UnknownSessionItem;

export function isTurnRunning(status: SessionTurnStatus): boolean {
	return status === "running";
}

/**
 * Where the composer submit goes. A running chat keeps the follow-up: treating
 * it as a new-chat draft dropped the session id and the server opened another
 * chat. A turn already on screen whose id has not landed yet is held, so a
 * second send does not open one either.
 */
export function composerSubmitTarget(input: {
	readonly newChatDraft: boolean;
	readonly openChatId?: string;
	readonly turnStatus: SessionTurnStatus;
}): {
	readonly startsNewChat: boolean;
	readonly sessionId?: string;
	readonly waitForChat?: boolean;
} {
	if (input.openChatId && isTurnRunning(input.turnStatus)) {
		return { startsNewChat: false, sessionId: input.openChatId };
	}
	if (isTurnRunning(input.turnStatus)) {
		return { startsNewChat: false, waitForChat: true };
	}
	if (input.newChatDraft) return { startsNewChat: true };
	return {
		startsNewChat: false,
		...(input.openChatId ? { sessionId: input.openChatId } : {}),
	};
}

export function liveActivityStatus(
	item: SessionItem,
): ToolActivityStatus | null {
	if (
		item.kind === "commandExecution" ||
		item.kind === "fileChange" ||
		item.kind === "mcpToolCall" ||
		item.kind === "dynamicToolCall"
	) {
		return item.status;
	}
	if (item.kind === "reasoning" && item.durationSeconds == null) {
		return "inProgress";
	}
	return null;
}

export function fileChangesFromSessionItems(
	items: readonly SessionItem[],
): readonly FileChangeEntry[] {
	const latestByPath = new Map<string, FileChangeEntry>();
	for (const item of items) {
		if (item.kind !== "commandExecution") continue;
		for (const change of fileChangesFromShellCommand(item.command)) {
			latestByPath.set(change.path, change);
		}
	}
	for (const item of items) {
		if (item.kind !== "fileChange") continue;
		for (const change of item.changes) {
			latestByPath.set(change.path, change);
		}
	}
	return [...latestByPath.values()];
}

export function lastUserMessageText(
	items: readonly SessionItem[],
): string | null {
	for (let index = items.length - 1; index >= 0; index -= 1) {
		const item = items[index];
		if (
			item?.kind === "userMessage" &&
			item.text.trim() &&
			!isWorkspacePreamble(item.text)
		) {
			return item.text;
		}
	}
	return null;
}

export function lastAgentMessageText(
	items: readonly SessionItem[],
): string | null {
	for (let index = items.length - 1; index >= 0; index -= 1) {
		const item = items[index];
		if (item?.kind === "agentMessage" && item.text.trim()) return item.text;
	}
	return null;
}

export function sessionItemsFromUnknown(value: unknown): SessionItem[] {
	return Array.isArray(value)
		? normalizeRuntimeUserMessages(value as SessionItem[])
		: [];
}

function normalizeRuntimeUserMessages(
	items: readonly SessionItem[],
): SessionItem[] {
	return items.map((item) =>
		item.kind === "userMessage"
			? { ...item, text: visibleRuntimeUserText(item.text) }
			: item,
	);
}

/** The transcript already holds the message this send (by its id) adds. */
export function sendWasQueued(
	items: readonly SessionItem[],
	messageId: string | undefined,
): boolean {
	return Boolean(
		messageId &&
			items.some(
				(item) => item.kind === "userMessage" && item.id === messageId,
			),
	);
}

/**
 * Adds the user's message once. The message id is the send's identity, so a
 * replayed request adds nothing while a deliberate repeat ("continue") is new.
 */
export function sessionItemsQueuedWithUser(
	items: readonly SessionItem[],
	text: string,
	messageId?: string,
	approvesPlan?: boolean,
	attachments?: readonly MessageAttachment[],
): SessionItem[] {
	const queued = text.trim();
	if (!queued) return [...items];
	if (sendWasQueued(items, messageId)) return [...items];
	// An approval repeats the same words each time; it is a duplicate only once nothing waits.
	if (approvesPlan && !pendingPlanId(items)) return [...items];
	return [
		...items,
		{
			kind: "userMessage",
			id: SessionItemId(
				messageId ?? `queued-user-${items.length}-${queued.length}`,
			),
			text: queued,
			...(attachments?.length ? { attachments } : {}),
			...(approvesPlan ? { approvesPlan: true as const } : {}),
			timing: { startedAt: Date.now() },
		},
	];
}

function lastUserMessage(
	items: readonly SessionItem[],
): UserMessageItem | null {
	for (let index = items.length - 1; index >= 0; index -= 1) {
		const item = items[index];
		if (
			item?.kind === "userMessage" &&
			item.text.trim() &&
			!isWorkspacePreamble(item.text)
		) {
			return item;
		}
	}
	return null;
}

/**
 * The open chat right after a recovery the server confirmed. A restore of
 * this chat shows the restored transcript at once (null: a code-only
 * restore keeps it); another chat (a fork) is opened instead, so this is
 * null and the caller switches chats.
 */
export function sessionViewAfterRecovery<
	View extends {
		readonly agentSessionId?: string | null;
		readonly items: readonly SessionItem[];
		readonly turnStatus: SessionTurnStatus;
	},
>(
	current: View,
	recovered: {
		readonly id: string;
		readonly items: readonly SessionItem[] | null;
	},
): View | null {
	if (current.agentSessionId !== recovered.id) return null;
	if (!recovered.items) return current;
	return { ...current, items: recovered.items, turnStatus: "idle" };
}

/**
 * Whether a server view may replace the open chat while it shows a running turn.
 * A view from before the send landed must not erase the message just sent, so a
 * settled view counts only when it carries that same message (by id). An idle
 * view means the turn was stopped: it counts after the user pressed Stop, or when
 * the server already holds the message and says nothing is running.
 */
export function sessionViewShouldReplaceOpenTurn(input: {
	readonly currentStatus: SessionTurnStatus;
	readonly nextStatus: SessionTurnStatus;
	readonly currentItems: readonly SessionItem[];
	readonly nextItems: readonly SessionItem[];
	readonly stopRequested?: boolean;
}): boolean {
	if (input.currentStatus !== "running") return true;
	if (input.nextStatus === "running") return true;
	if (input.nextStatus === "idle" && input.stopRequested) return true;
	const currentUser = lastUserMessage(input.currentItems);
	// Nothing was sent from here; the server's state is the only truth.
	if (!currentUser) return true;
	const nextUser = lastUserMessage(input.nextItems);
	if (!nextUser || nextUser.id !== currentUser.id) return false;
	if (input.nextStatus === "idle") return true;
	return turnSettledAfterUser(input.nextItems, currentUser.id);
}

function turnSettledAfterUser(
	items: readonly SessionItem[],
	userId: SessionItemId,
): boolean {
	let lastUser = -1;
	for (let index = 0; index < items.length; index += 1) {
		const item = items[index];
		if (item?.kind === "userMessage" && item.id === userId) lastUser = index;
	}
	if (lastUser < 0) return false;
	return items
		.slice(lastUser + 1)
		.some(
			(item) =>
				item.kind === "agentMessage" ||
				item.kind === "error" ||
				(item.kind === "modelSwitch" && item.state === "awaitingApproval"),
		);
}

/**
 * Takes back a send the server never accepted: its message leaves the
 * transcript and the turn returns to where it was before the send.
 */
export function sessionWithoutFailedSend<
	T extends {
		readonly items: readonly SessionItem[];
		readonly turnStatus: SessionTurnStatus;
	},
>(session: T, messageId: string, previousStatus: SessionTurnStatus): T {
	if (!sendWasQueued(session.items, messageId)) return session;
	return {
		...session,
		items: session.items.filter((item) => item.id !== messageId),
		turnStatus:
			session.turnStatus === "running" ? previousStatus : session.turnStatus,
	};
}

export function sessionUsesFollowUpLayout(input: {
	readonly items: readonly SessionItem[];
	readonly turnStatus: SessionTurnStatus;
	readonly listedTitle?: string;
}): boolean {
	return (
		Boolean(lastUserMessageText(input.items)) ||
		input.turnStatus === "running" ||
		Boolean(input.listedTitle && input.listedTitle !== "New session")
	);
}

export function sessionTitleFromItems(items: readonly SessionItem[]): string {
	return sessionTitleFromText(lastUserMessageText(items) ?? "");
}

/**
 * The open chat's header: the title the sidebar lists (set from the first
 * message), so both name the chat the same way; until the list has one, the
 * title from the latest message.
 */
export function chatHeaderTitle(
	listedTitle: string | undefined,
	fromItems: string,
): string {
	return listedTitle?.trim() && listedTitle !== "New session"
		? listedTitle
		: fromItems;
}

/** A chat's title from its first message: the first line, shortened. */
/** A chat's title until its first message names it. */
export const UNTITLED_SESSION_TITLE = "New session";

export function sessionTitleFromText(text: string): string {
	if (!text) return UNTITLED_SESSION_TITLE;
	if (isEnvironmentSetupPrompt(text)) return ENVIRONMENT_SETUP_TITLE;
	const line = text.trim().split("\n")[0]?.trim() ?? "";
	if (!line) return UNTITLED_SESSION_TITLE;
	return line.length > 48 ? `${line.slice(0, 47)}…` : line;
}

/**
 * Public items with the messages still waiting for delivery after them, in
 * send order. A message the transcript already holds is no longer waiting.
 */
export function withQueuedUserMessages(
	items: readonly SessionItem[],
	queued: readonly UserMessageItem[],
): SessionItem[] {
	const present = new Set(items.map((item) => item.id));
	return [
		...items,
		...queued
			.filter((item) => !present.has(item.id))
			.map((item) => ({ ...item, queued: true as const })),
	];
}

/** The chat's message waiting for the project's environment, if any. */
export function heldForSetupMessage(
	items: readonly SessionItem[],
): UserMessageItem | null {
	for (const item of items)
		if (item.kind === "userMessage" && item.queued && item.heldForSetup)
			return item;
	return null;
}

/** The message reached its turn: the transcript holds it as sent, no longer waiting. */
export function messageDelivered(
	items: readonly SessionItem[],
	messageId: string,
): boolean {
	return items.some(
		(item) =>
			item.kind === "userMessage" && item.id === messageId && !item.queued,
	);
}

/**
 * A read taken while a released held message moves from the chat's waiting
 * row into its turn's transcript has it nowhere. The message stays shown as
 * it was until a read holds it again, so it neither blinks out nor shows twice.
 */
export function itemsKeepingMessageInFlight(
	current: readonly SessionItem[],
	next: readonly SessionItem[],
	messageId: string,
): readonly SessionItem[] {
	if (next.some((item) => item.id === messageId)) return next;
	const shown = current.find(
		(item) =>
			item.kind === "userMessage" && item.id === messageId && item.queued,
	);
	return shown ? [...next, shown] : next;
}

/** The browser's copy of a send made during a run, shown waiting until delivered. */
export function markedQueuedSend(
	items: readonly SessionItem[],
	messageId: string,
): SessionItem[] {
	return items.map((item) =>
		item.kind === "userMessage" && item.id === messageId
			? { ...item, queued: true as const }
			: item,
	);
}

export function isQueuedUserMessage(
	item: SessionItem,
): item is UserMessageItem & { readonly queued: true } {
	return item.kind === "userMessage" && item.queued === true;
}

export function visibleSessionItems(
	serverItems: readonly SessionItem[],
	optimisticItems: readonly SessionItem[],
): SessionItem[] {
	if (optimisticItems.length === 0) return [...serverItems];
	return [
		...serverItems,
		...optimisticItems.filter(
			(item) =>
				item.kind !== "userMessage" ||
				!serverItems.some(
					(existing) =>
						existing.kind === "userMessage" && existing.id === item.id,
				),
		),
	];
}

export function compactTimelineItems(
	items: readonly SessionItem[],
): SessionItem[] {
	const presented: SessionItem[] = [];
	for (const item of normalizeRuntimeUserMessages(items)) {
		if (item.kind === "userMessage" && isWorkspacePreamble(item.text)) {
			continue;
		}
		if (item.kind === "commandExecution") {
			presented.push(...presentCommandExecution(item));
			continue;
		}
		presented.push(item);
	}
	return presented;
}

function isWorkspacePreamble(text: string): boolean {
	return text.startsWith("You are in a ytimesy workspace VM.");
}

export function showTurnWorking(
	items: readonly SessionItem[],
	turnStatus: SessionTurnStatus,
): boolean {
	if (turnStatus !== "running") return false;
	const last = compactTimelineItems(items).at(-1);
	if (last == null || last.kind === "userMessage") return true;
	if (
		last.kind === "agentMessage" ||
		last.kind === "error" ||
		last.kind === "memorySave"
	)
		return false;
	if (last.kind === "reasoning") return false;
	// It shows its own "Saving changes…" line.
	if (last.kind === "notice" && last.savingChanges) return false;
	if (last.kind === "commandExecution" && last.status === "inProgress") {
		return false;
	}
	if (last.kind === "fileChange" && last.status === "inProgress") {
		return false;
	}
	if (last.kind === "dynamicToolCall" && last.status === "inProgress") {
		return false;
	}
	if (last.kind === "mcpToolCall" && last.status === "inProgress") {
		return false;
	}
	return true;
}

function presentCommandExecution(item: CommandExecutionItem): SessionItem[] {
	const writes = fileChangesFromShellCommand(item.command);
	if (writes.length === 0) return [item];
	const remainder = remainingShellCommandAfterWrites(item.command, writes);
	const files: FileChangeItem = {
		kind: "fileChange",
		id: remainder ? SessionItemId(`${item.id}:files`) : item.id,
		status: item.status,
		changes: writes,
	};
	if (!remainder) return [files];
	return [files, { ...item, command: remainder }];
}

/** A chat continued from a local agent session, before the user's first message in it. */
export function continuedChatAwaitsMessage(items: readonly SessionItem[]) {
	return (
		items.some((item) => item.kind === "handoff") &&
		!items.some((item) => item.kind === "userMessage")
	);
}
