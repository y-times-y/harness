import type { AgentProviderId } from "./agent-provider";
import type { SessionTurnStatus } from "./session-item";

export type AgentTaskStatus =
	| "draft"
	| "working"
	| "waiting"
	| "idle"
	| "done"
	| "failed";

/** Poll a chat's subagents while the chat runs or any subagent is busy. */
export function shouldPollSubagents(
	chatStatus: SessionTurnStatus,
	tasks: readonly Pick<AgentTask, "status">[],
): boolean {
	return (
		chatStatus === "running" ||
		tasks.some((task) => task.status === "working" || task.status === "waiting")
	);
}
export type AgentTaskPlacement = "shared" | "fresh";
export type AgentTaskAccess = "read_only" | "read_write";
export type AgentTaskReviewState = "pending" | "reviewed" | "rejected";

/**
 * How a completed turn reaches GitHub. Every root chat ("chat") commits,
 * pushes its own branch and keeps a draft PR open; its task_access is not
 * consulted (root chats carry the legacy 'read_only' label). Subagents never
 * publish: their work reaches the parent as a report or patch. Machine-less
 * sessions publish nothing.
 */
export function turnPublicationRole(session: {
	readonly providerRef: string | null;
	readonly parentSessionId: string | null;
}): "chat" | null {
	return session.providerRef && !session.parentSessionId ? "chat" : null;
}

export type AgentTask = {
	readonly id: string;
	readonly parentSessionId: string;
	readonly title: string;
	readonly label: string;
	readonly depth: number;
	readonly status: AgentTaskStatus;
	readonly prompt: string;
	readonly placement: AgentTaskPlacement;
	readonly access: AgentTaskAccess;
	readonly summary: string | null;
	readonly harnessId: AgentProviderId;
	readonly listedModelId: string | null;
	readonly createdAt: string;
	readonly updatedAt: string;
};

type TaskSession = {
	readonly id: string;
	readonly parentSessionId: string | null;
	readonly title: string;
	readonly turnStatus: SessionTurnStatus;
	readonly harness: AgentProviderId;
	readonly listedModelId: string | null;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly taskPrompt?: string | null;
	readonly taskState?: AgentTaskStatus | null;
	readonly taskPlacement?: AgentTaskPlacement | null;
	readonly taskAccess?: AgentTaskAccess | null;
	readonly taskSummary?: string | null;
};

export function taskStatusFromTurn(
	turnStatus: SessionTurnStatus,
	storedStatus?: AgentTaskStatus | null,
): AgentTaskStatus {
	if (turnStatus === "running") return "working";
	if (storedStatus) return storedStatus;
	if (turnStatus === "completed") return "done";
	if (turnStatus === "failed") return "failed";
	return "idle";
}

/**
 * Task labels are positional inside their parent, matching the hierarchy the
 * user sees: Task 1, Task 1.1, Task 1.2, and so on.
 */
export function agentTaskTree(
	rootSessionId: string,
	sessions: readonly TaskSession[],
): readonly AgentTask[] {
	const children = new Map<string, TaskSession[]>();
	for (const session of sessions) {
		if (!session.parentSessionId) continue;
		const siblings = children.get(session.parentSessionId) ?? [];
		siblings.push(session);
		children.set(session.parentSessionId, siblings);
	}
	for (const siblings of children.values()) {
		siblings.sort((left, right) =>
			left.createdAt.localeCompare(right.createdAt),
		);
	}

	const tasks: AgentTask[] = [];
	function append(parentId: string, prefix: string, depth: number) {
		for (const [index, session] of (children.get(parentId) ?? []).entries()) {
			const position = prefix ? `${prefix}.${index + 1}` : `${index + 1}`;
			tasks.push({
				id: session.id,
				parentSessionId: parentId,
				title: session.title,
				label: `Task ${position}`,
				depth,
				status: taskStatusFromTurn(session.turnStatus, session.taskState),
				prompt: session.taskPrompt ?? "",
				placement: session.taskPlacement ?? "fresh",
				access: session.taskAccess ?? "read_write",
				summary: session.taskSummary ?? null,
				harnessId: session.harness,
				listedModelId: session.listedModelId,
				createdAt: session.createdAt,
				updatedAt: session.updatedAt,
			});
			append(session.id, position, depth + 1);
		}
	}
	append(rootSessionId, "", 1);
	return tasks;
}
