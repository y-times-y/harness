import { describe, expect, it } from "vitest";
import { SessionItemId } from "./ids";
import type { SessionItem } from "./session-item";
import {
	type SubagentTreeSession,
	subagentNodeRemaining,
	subagentTree,
} from "./subagent-tree";

const NOW = Date.parse("2026-10-18T12:00:00.000Z");
const minutesAgo = (minutes: number) =>
	new Date(NOW - minutes * 60_000).toISOString();

const usage = (input: number, output: number): SessionItem[] => [
	{
		kind: "userMessage",
		id: SessionItemId(`u-${input}`),
		text: "go",
		apiUsage: {
			inputTokens: input,
			outputTokens: output,
			uncachedInputTokens: input,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		},
	},
];

const SONNET = "anthropic/claude-sonnet-5.5";

function session(
	id: string,
	parent: string | null,
	fields: Partial<SubagentTreeSession> = {},
): SubagentTreeSession {
	return {
		id,
		parentSessionId: parent,
		title: id,
		turnStatus: "idle",
		harness: "api",
		listedModelId: SONNET,
		createdAt: minutesAgo(20),
		updatedAt: minutesAgo(1),
		items: [],
		...fields,
	};
}

const sessions = (): SubagentTreeSession[] => [
	session("root", null, { items: usage(1_000_000, 100_000) }),
	session("w", "root", {
		agentRole: "writer",
		turnStatus: "running",
		createdAt: minutesAgo(10),
		agentSteps: 12,
		agentBudget: { steps: 150, minutes: 30, tokens: 2_000_000 },
		agentFork: {
			vmId: "vm-fork",
			sourceVmId: "vm-root",
			bootedAt: minutesAgo(9),
		},
		items: usage(400_000, 20_000),
	}),
	session("r", "w", {
		agentRole: "researcher",
		turnStatus: "idle",
		taskState: "done",
		createdAt: minutesAgo(5),
		agentSteps: 7,
		agentBudget: { steps: 75, minutes: 15, tokens: 1_000_000 },
		items: usage(100_000, 10_000),
	}),
	// A child from the older task tools: not part of the subagent tree.
	session("legacy", "root", { createdAt: minutesAgo(15), items: usage(1, 1) }),
];

describe("subagent tree", () => {
	it("labels nodes by position and shows role, VM, state, budget use and spend", () => {
		const tree = subagentTree("root", sessions(), NOW);
		expect(tree.nodes.map((node) => [node.label, node.role, node.vm])).toEqual([
			["2", "writer", "fork"],
			["2.1", "researcher", "shared"],
		]);
		const [writer, reader] = tree.nodes;
		expect(writer).toMatchObject({
			level: 1,
			state: "working",
			live: true,
			steps: 12,
		});
		expect(writer?.minutes).toBeCloseTo(10);
		expect(writer?.spend.vmMinutes).toBeCloseTo(9);
		expect(reader).toMatchObject({ level: 2, state: "done", live: false });
		expect(reader?.spend.vmMinutes).toBe(0);
		// Subtree tokens include the reader under the writer.
		expect(writer?.subtree.tokens).toBe(530_000);
		// $2/M in, $10/M out: 0.5M in + 0.03M out over the writer subtree.
		expect(writer?.subtree.costUsd).toBeCloseTo(1 + 0.3);
		expect(tree.total.tokens).toBe(1_100_000 + 530_000);
		expect(tree.builder.tokens).toBe(1_100_000);
	});

	it("stops a finished helper's minutes and VM minutes at its last turn's end", () => {
		const ended = (endedMinutesAgo: number): SessionItem[] => [
			{
				kind: "userMessage",
				id: SessionItemId("u-done"),
				text: "go",
				timing: {
					startedAt: NOW - 10 * 60_000,
					completedAt: NOW - endedMinutesAgo * 60_000,
				},
			},
		];
		const tree = subagentTree(
			"root",
			[
				session("root", null),
				// Finished 6 minutes ago after 4; its row was updated since.
				session("r", "root", {
					agentRole: "researcher",
					turnStatus: "completed",
					taskState: "done",
					createdAt: minutesAgo(10),
					updatedAt: minutesAgo(1),
					agentBudget: { steps: 75, minutes: 30, tokens: 1_000_000 },
					items: ended(6),
				}),
				// Its fork waits for deletion (30 minutes after its report).
				session("w", "root", {
					agentRole: "writer",
					turnStatus: "completed",
					taskState: "done",
					createdAt: minutesAgo(10),
					agentFork: {
						vmId: "vm-fork",
						sourceVmId: "vm-root",
						bootedAt: minutesAgo(9),
						reportedAt: minutesAgo(7),
					},
					items: ended(7),
				}),
				// Older turns without a recorded end: the row's update time.
				session("old", "root", {
					agentRole: "researcher",
					turnStatus: "completed",
					taskState: "done",
					createdAt: minutesAgo(10),
					updatedAt: minutesAgo(8),
					items: [],
				}),
			],
			NOW,
		);
		const byId = new Map(tree.nodes.map((node) => [node.id, node]));
		expect(byId.get("r")?.minutes).toBeCloseTo(4);
		expect(byId.get("w")?.minutes).toBeCloseTo(3);
		expect(byId.get("w")?.spend.vmMinutes).toBeCloseTo(2);
		expect(byId.get("old")?.minutes).toBeCloseTo(2);
	});

	it("counts a node's subtree tokens against its remaining budget", () => {
		const [writer] = subagentTree("root", sessions(), NOW).nodes;
		expect(writer && subagentNodeRemaining(writer)).toMatchObject({
			steps: 138,
			tokens: 2_000_000 - 530_000,
		});
	});

	it("leaves a side chat out of the helper tree", () => {
		const tree = subagentTree(
			"root",
			[
				session("root", null),
				session("side", "root", {
					agentRole: "writer",
					turnStatus: "running",
					taskState: "working",
					agentBudget: { sideChat: true, steps: 10, minutes: 10, tokens: 10 },
				}),
				session("helper", "root", { agentRole: "researcher" }),
			],
			NOW,
		);
		expect(tree.nodes.map((node) => node.id)).toEqual(["helper"]);
	});

	it("prices a plan-billed tree at list price and labels it an estimate", () => {
		const plan = sessions().map((entry) => ({
			...entry,
			harness: "codex" as const,
		}));
		const tree = subagentTree("root", plan, NOW);
		expect(tree.total.planBilled).toBe(true);
		expect(tree.total.costUsd).toBeGreaterThan(0);
	});
});
