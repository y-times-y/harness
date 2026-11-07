import type { AgentProviderId } from "./agent-provider";
import {
	type AgentTaskStatus,
	agentTaskTree,
	taskStatusFromTurn,
} from "./agent-task";
import {
	helperIdentitiesOf,
	helperKindOf,
	helperReference,
} from "./helper-names";
import { sessionBilling } from "./model-pricing";
import {
	type SessionItem,
	type SessionTurnStatus,
	sessionItemsFromUnknown,
} from "./session-item";
import { sessionsInSubagentTree } from "./side-chat";
import {
	type SubagentBudget,
	type SubagentFork,
	type SubagentRemaining,
	type SubagentRole,
	subagentLabelFromTaskLabel,
	subagentPlacement,
	subagentRemaining,
} from "./subagent";
import {
	type AgentSpend,
	agentSpend,
	budgetTokenWeight,
	forkVmMinutes,
	subtreeSpends,
	totalSpend,
} from "./subagent-usage";
import { lastTurnEnd } from "./turn-end";

/** The session fields the tree reads (AgentSessionRecord satisfies it). */
export type SubagentTreeSession = {
	readonly id: string;
	readonly parentSessionId: string | null;
	readonly title: string;
	readonly turnStatus: SessionTurnStatus;
	readonly harness: AgentProviderId;
	readonly listedModelId: string | null;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly items: unknown;
	readonly taskState?: AgentTaskStatus | null;
	readonly agentRole?: SubagentRole | null;
	readonly agentBudget?: SubagentBudget | null;
	readonly agentFork?: SubagentFork | null;
	readonly agentSteps?: number;
};

export type SubagentNode = {
	readonly id: string;
	readonly parentId: string;
	/** Positional id: 1, 1.2, 1.2.1. */
	readonly label: string;
	/** How the chat names it (helper-names.ts): build-1 ("Build the CSV export"). */
	readonly name: string;
	/** Its short name alone: build-1. */
	readonly shortName: string;
	readonly level: number;
	readonly title: string;
	readonly role: SubagentRole;
	readonly vm: "fork" | "shared";
	readonly state: AgentTaskStatus;
	readonly live: boolean;
	readonly steps: number;
	readonly minutes: number;
	readonly budget: SubagentBudget | null;
	/** This agent's own spend. */
	readonly spend: AgentSpend;
	/** Its own plus every descendant's. */
	readonly subtree: AgentSpend;
};

export type SubagentTree = {
	readonly nodes: readonly SubagentNode[];
	/** The whole tree, the builder's own spend included. */
	readonly total: AgentSpend;
	readonly builder: AgentSpend;
};

/**
 * When a finished agent stopped: its last turn's recorded end, or for turns
 * from before ends were recorded its row's update time. Null while it works.
 * A finished helper's clock and VM minutes stop here, not at now.
 */
function finishedAt(
	session: SubagentTreeSession,
	items: readonly SessionItem[],
) {
	const status = taskStatusFromTurn(session.turnStatus, session.taskState);
	if (status === "working" || status === "waiting") return null;
	const end = lastTurnEnd(items) ?? Date.parse(session.updatedAt);
	return Number.isFinite(end) ? end : null;
}

function sessionSpend(
	session: SubagentTreeSession,
	now: number,
	basisModelId: string | null,
) {
	const items = sessionItemsFromUnknown(
		session.items,
	) as readonly SessionItem[];
	return agentSpend({
		items,
		billing: sessionBilling(session),
		vmMinutes: forkVmMinutes(
			session.agentFork ?? null,
			now,
			finishedAt(session, items),
		),
		budgetWeight: budgetTokenWeight(session.listedModelId, basisModelId),
	});
}

/**
 * The subagent tree under a root (the builder): every child started through
 * the agent tool, with positional labels, state, budget use and spend.
 * Children from the older task tools are left out.
 */
export function subagentTree(
	rootId: string,
	allSessions: readonly SubagentTreeSession[],
	now: number,
): SubagentTree {
	const sessions = sessionsInSubagentTree(rootId, allSessions);
	const byId = new Map(sessions.map((session) => [session.id, session]));
	// Budgets are in the builder's tokens: each agent's tokens are weighted by
	// its model's price relative to the builder's.
	const basis = byId.get(rootId)?.listedModelId ?? null;
	const spends = new Map(
		sessions.map((session) => [session.id, sessionSpend(session, now, basis)]),
	);
	const subtrees = subtreeSpends(
		sessions.map((session) => ({
			id: session.id,
			parentId: session.parentSessionId,
			spend: spends.get(session.id) as AgentSpend,
		})),
	);
	const tasks = agentTaskTree(
		rootId,
		sessions.filter((session) => session.id !== rootId) as never,
	);
	// Short names and numbers in start order, as the chat shows them.
	const identities = helperIdentitiesOf(
		tasks.flatMap((task) => {
			const session = byId.get(task.id);
			return session?.agentRole
				? [
						{
							id: task.id,
							createdAt: session.createdAt,
							title: task.title,
							kind: helperKindOf(session.agentRole, session.agentBudget),
						},
					]
				: [];
		}),
	);
	const nodes: SubagentNode[] = [];
	for (const task of tasks) {
		const session = byId.get(task.id);
		if (!session?.agentRole) continue;
		const end = Math.min(
			now,
			finishedAt(
				session,
				sessionItemsFromUnknown(session.items) as readonly SessionItem[],
			) ?? now,
		);
		const minutes = Math.max(0, (end - Date.parse(session.createdAt)) / 60_000);
		const shortName = identities.get(task.id)?.name ?? "subagent";
		nodes.push({
			id: task.id,
			parentId: task.parentSessionId,
			label: subagentLabelFromTaskLabel(task.label),
			name: helperReference(shortName, task.title),
			shortName,
			level: task.depth,
			title: task.title,
			role: session.agentRole,
			// Lead mode fusion's sidekick is a writer in its lead's checkout.
			vm:
				subagentPlacement(session.agentRole) === "fork" &&
				!session.agentBudget?.sidekick
					? "fork"
					: "shared",
			state: task.status,
			live: task.status === "working" || task.status === "waiting",
			steps: session.agentSteps ?? 0,
			minutes,
			budget: session.agentBudget ?? null,
			spend: spends.get(task.id) as AgentSpend,
			subtree: subtrees.get(task.id) as AgentSpend,
		});
	}
	const builder = spends.get(rootId) ?? totalSpend([]);
	return {
		nodes,
		builder,
		total: totalSpend([builder, ...nodes.map((node) => node.spend)]),
	};
}

/** What a node has left of its budget (subtree tokens count against it). */
export function subagentNodeRemaining(
	node: SubagentNode,
): SubagentRemaining | null {
	return node.budget
		? subagentRemaining(node.budget, {
				steps: node.steps,
				minutes: node.minutes,
				tokens: node.subtree.budgetTokens,
			})
		: null;
}

/** What the task panel shows for a subagent row (no prompts, no transcripts). */
export type SubagentTaskView = {
	readonly role: SubagentRole;
	/** How the chat names it (helper-names.ts): build-1 ("Its task"). */
	readonly name?: string;
	readonly vm: "fork" | "shared";
	readonly steps: number;
	readonly minutes: number;
	readonly budget: SubagentBudget | null;
	/** Own spend, children excluded. */
	readonly spend: AgentSpend;
	/** Own plus every descendant's spend. */
	readonly subtree: AgentSpend;
};

/** The subagent view of each node, keyed by session id. */
export function subagentTaskViews(
	rootId: string,
	sessions: readonly SubagentTreeSession[],
	now: number,
): Map<string, SubagentTaskView> {
	return new Map(
		subagentTree(rootId, sessions, now).nodes.map((node) => [
			node.id,
			{
				role: node.role,
				name: node.name,
				vm: node.vm,
				steps: node.steps,
				minutes: node.minutes,
				budget: node.budget,
				spend: node.spend,
				subtree: node.subtree,
			},
		]),
	);
}
