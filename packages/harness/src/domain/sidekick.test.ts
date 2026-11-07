import { describe, expect, it } from "vitest";
import { SessionItemId } from "./ids";
import type { SessionItem } from "./session-item";
import {
	beginSidekickRound,
	completeSidekickSwitch,
	currentSidekickRound,
	endSidekickRound,
	fusionMetricsLine,
	fusionTurnMetrics,
	HARNESS_EXPLORE_HEADING,
	harnessExplorationBrief,
	isActiveSidekick,
	latestUserRequestId,
	markSidekickSwitch,
	newSidekickState,
	recordSidekickDecision,
	reportPushesBack,
	requestExplored,
	retireSidekickState,
	SIDEKICK_EXPLORE_NOTE,
	sidekickIdleSince,
	sidekickIdleTtlMinutes,
	sidekickRoundLabel,
	sidekickRoundMessage,
	sidekickRoundOpen,
	sidekickRoundRef,
	sidekickRoundsLeft,
	sidekickSwitchDue,
	subagentBudgetCheck,
} from "./sidekick";

const T0 = Date.parse("2026-10-19T10:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

describe("sidekick rounds", () => {
	it("starts at round 1 with half its tokens per round", () => {
		const state = newSidekickState({ tokens: 2_000_000 }, at(0));
		expect(state).toMatchObject({
			round: 1,
			maxRounds: 6,
			roundTokens: 1_000_000,
			rounds: [{ n: 1, startedAt: at(0) }],
		});
		expect(newSidekickState({ tokens: 60_000 }, at(0)).roundTokens).toBe(
			50_000,
		);
	});

	it("records each round and retires the sidekick after its last", () => {
		let state = newSidekickState({ tokens: 2_000_000 }, at(0));
		state = endSidekickRound(state, {
			now: at(5),
			outcome: "finished",
			patchFiles: 3,
		});
		expect(state.rounds[0]).toMatchObject({ endedAt: at(5), patchFiles: 3 });
		for (let n = 2; n <= 6; n++) {
			state = beginSidekickRound(state, {
				now: at(n * 10),
				steps: n * 20,
				tokens: n * 1000,
				base: `base-${n}`,
			});
			expect(state).toMatchObject({
				round: n,
				roundStartSteps: n * 20,
				roundStartedAt: at(n * 10),
			});
			expect(sidekickRoundOpen(state)).toBe(true);
			expect(currentSidekickRound(state)?.base).toBe(`base-${n}`);
			state = endSidekickRound(state, {
				now: at(n * 10 + 3),
				outcome: "finished",
				patchFiles: 1,
				end: `end-${n}`,
			});
			expect(sidekickRoundOpen(state)).toBe(false);
			expect(currentSidekickRound(state)?.end).toBe(`end-${n}`);
		}
		expect(state.rounds).toHaveLength(6);
		expect(sidekickRoundsLeft(state)).toBe(0);
		expect(state.retired).toEqual({ at: at(63), reason: "all rounds used" });
		expect(
			isActiveSidekick({
				agentRole: "writer",
				agentBudget: { steps: 1, minutes: 1, tokens: 1, sidekick: state },
			}),
		).toBe(false);
		// A retirement keeps its first reason.
		expect(retireSidekickState(state, "stopped", at(70)).retired?.reason).toBe(
			"all rounds used",
		);
	});

	it("checks a sidekick's budget per round and an ordinary agent's over its life", () => {
		const budget = { steps: 100, minutes: 30, tokens: 1_000_000 };
		expect(
			subagentBudgetCheck(
				budget,
				{ steps: 40, tokens: 1000, createdAt: at(0) },
				T0 + 45 * 60_000,
			),
		).toEqual({
			limits: budget,
			used: { steps: 40, minutes: 45, tokens: 1000 },
			reasonPrefix: "",
		});
		const state = beginSidekickRound(newSidekickState(budget, at(0)), {
			now: at(40),
			steps: 70,
			tokens: 600_000,
		});
		const check = subagentBudgetCheck(
			{ ...budget, sidekick: state, stopAtStep: 75 },
			{ steps: 72, tokens: 650_000, createdAt: at(0) },
			T0 + 45 * 60_000,
		);
		expect(check.used).toEqual({ steps: 2, minutes: 5, tokens: 50_000 });
		expect(check.limits).toMatchObject({
			steps: 100,
			minutes: 30,
			// Its own round's cap, though 600k of its 1M were used before the round.
			tokens: 500_000,
			stopAtStep: 5,
		});
		expect(check.reasonPrefix).toBe("round 2, ");
	});

	it("names a round's snapshots and tells the sidekick it works in the lead's checkout", () => {
		expect(sidekickRoundRef("1", 3, "start")).toBe(
			"refs/ytimesy/sidekick/1/round-3-start",
		);
		const message = sidekickRoundMessage({
			round: 3,
			maxRounds: 6,
			message: "  Fix the parser. ",
		});
		expect(message).toMatch(/^Round 3\/6 from Main\./);
		expect(message).toContain("You work in Main's checkout as it is now");
		expect(message.endsWith("\n\nFix the parser.")).toBe(true);
		expect(
			sidekickRoundMessage({
				round: 3,
				maxRounds: 6,
				message: "Look around.",
				kind: "explore",
			}).endsWith(SIDEKICK_EXPLORE_NOTE),
		).toBe(true);
	});

	it("writes the harness's exploration brief from the user's request", () => {
		const brief = harnessExplorationBrief("  Add a --json flag.  ");
		expect(brief.startsWith(HARNESS_EXPLORE_HEADING)).toBe(true);
		expect(brief).toContain("<request>\nAdd a --json flag.\n</request>");
		expect(brief).toContain("the key snippets with their line ranges");
		expect(brief.endsWith(SIDEKICK_EXPLORE_NOTE)).toBe(true);
		const long = harnessExplorationBrief("x".repeat(9_000));
		expect(long).toContain("[request truncated]");
		expect(long.length).toBeLessThan(6_500);
	});

	it("knows whether a request has its exploration round", () => {
		const explored = newSidekickState({ tokens: 1_000_000 }, at(0), {
			requestKey: "u1",
			kind: "explore",
		});
		expect(requestExplored([explored], "u1")).toBe(true);
		expect(requestExplored([explored], "u2")).toBe(false);
		const built = newSidekickState({ tokens: 1_000_000 }, at(0), {
			requestKey: "u1",
		});
		expect(requestExplored([built], "u1")).toBe(false);
		// The next request's build round on the same sidekick is no exploration of it.
		const next = beginSidekickRound(
			endSidekickRound(explored, {
				now: at(1),
				outcome: "finished",
				patchFiles: 0,
			}),
			{ now: at(2), steps: 0, tokens: 0, requestKey: "u2" },
		);
		expect(requestExplored([next], "u2")).toBe(false);
		expect(
			requestExplored(
				[
					beginSidekickRound(next, {
						now: at(3),
						steps: 0,
						tokens: 0,
						requestKey: "u2",
						kind: "explore",
					}),
				],
				"u2",
			),
		).toBe(true);
	});
});

describe("sidekick lifetime across the chat's requests", () => {
	it("counts rounds per user request and labels later requests' rounds", () => {
		let state = newSidekickState({ tokens: 2_000_000 }, at(0), {
			requestKey: "u1",
			kind: "explore",
		});
		expect(state.rounds[0]?.kind).toBe("explore");
		for (let n = 2; n <= 6; n++)
			state = beginSidekickRound(
				endSidekickRound(state, {
					now: at(n),
					outcome: "finished",
					patchFiles: 1,
				}),
				{ now: at(n), steps: 0, tokens: 0, requestKey: "u1" },
			);
		expect(sidekickRoundsLeft(state, "u1")).toBe(0);
		// The user's next message: a fresh count for the same sidekick.
		expect(sidekickRoundsLeft(state, "u2")).toBe(6);
		state = endSidekickRound(state, {
			now: at(7),
			outcome: "finished",
			patchFiles: 1,
		});
		// The sixth round of a request retires it.
		expect(state.retired?.reason).toBe("all rounds used");
		const kept = beginSidekickRound(
			{ ...state, retired: undefined },
			{ now: at(60), steps: 0, tokens: 0, requestKey: "u2" },
		);
		expect(kept).toMatchObject({ round: 7, turnFirstRound: 7, turns: 2 });
		expect(sidekickRoundLabel(kept)).toBe("round 7 (1/6 this turn)");
		expect(sidekickRoundsLeft(kept, "u2")).toBe(5);
		expect(sidekickIdleSince(kept)).toBeNull();
		expect(sidekickIdleSince(state)).toBe(at(7));
	});

	it("reads the idle TTL from the environment, 30 minutes by default", () => {
		expect(sidekickIdleTtlMinutes({})).toBe(30);
		expect(sidekickIdleTtlMinutes({ YTIMESY_SIDEKICK_IDLE_MINUTES: "5" })).toBe(
			5,
		);
		expect(
			sidekickIdleTtlMinutes({ YTIMESY_SIDEKICK_IDLE_MINUTES: "never" }),
		).toBe(30);
	});

	it("finds the latest user request, skipping child reports and peer messages", () => {
		const items: SessionItem[] = [
			{ kind: "userMessage", id: SessionItemId("u1"), text: "Build it" },
			{
				kind: "userMessage",
				id: SessionItemId("c1"),
				text: "\u2063ytimesy-child-event:abc\n[agent 1 writer finished]",
			},
			{
				kind: "userMessage",
				id: SessionItemId("p1"),
				text: "Peer message from x (y):\n\nhello",
			},
		];
		expect(latestUserRequestId(items)).toBe("u1");
		expect(latestUserRequestId([])).toBeUndefined();
	});
});

describe("fusion turn metrics", () => {
	const usage = (input: number, output: number) => ({
		inputTokens: input,
		outputTokens: output,
		uncachedInputTokens: input,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
	});
	const call = (tool: string, input: unknown, id: string): SessionItem => ({
		kind: "dynamicToolCall",
		id: SessionItemId(id),
		tool,
		input: JSON.stringify(input),
		status: "completed",
	});
	const leadItems: SessionItem[] = [
		{
			kind: "userMessage",
			id: SessionItemId("u"),
			text: "Build it",
			apiUsage: usage(100_000, 5_000),
		},
		call("agent", { role: "writer", title: "x", brief: "y" }, "1"),
		call("agent", { role: "researcher", title: "x", brief: "y" }, "2"),
		call("bash", { command: "git diff abc refs/ytimesy/agents/1" }, "3"),
		call(
			"bash",
			{ command: "git add -A && git apply -3 ~/.ytimesy/agents/1.patch" },
			"4",
		),
		call("agent_send", { id: "1", message: "fix it" }, "5"),
		call(
			"exec_command",
			{ cmd: "git apply -3 ~/.ytimesy/agents/1.r2.patch" },
			"6",
		),
		call("edit", { path: "a.ts" }, "7"),
		call("write", { path: "b.ts" }, "8"),
		call("apply_patch", { input: "*** Begin Patch" }, "9"),
		call("read", { path: "a.ts" }, "10"),
	];
	const state = endSidekickRound(
		beginSidekickRound(
			endSidekickRound(newSidekickState({ tokens: 2_000_000 }, at(0)), {
				now: at(6),
				outcome: "finished",
				patchFiles: 2,
			}),
			{ now: at(10), steps: 30, tokens: 10_000 },
		),
		{
			now: at(14),
			outcome: "finished",
			patchFiles: 1,
			signals: [{ kind: "same-check-failed", detail: "make test" }],
		},
	);
	const sessions = [
		{
			id: "root",
			parentSessionId: null,
			harness: "codex",
			listedModelId: "gpt-6.1-sol",
			items: leadItems,
		},
		{
			id: "s",
			parentSessionId: "root",
			harness: "codex",
			listedModelId: "gpt-6-luna",
			agentRole: "writer" as const,
			agentBudget: {
				steps: 150,
				minutes: 30,
				tokens: 2_000_000,
				sidekick: state,
			},
			items: [
				{
					kind: "userMessage",
					id: SessionItemId("s-u"),
					text: "brief",
					apiUsage: usage(400_000, 20_000),
				},
				call("read", { path: "src/a.ts" }, "s-1"),
				call("bash", { command: "sed -n 1,80p src/b.ts" }, "s-2"),
				call("bash", { command: "make test" }, "s-3"),
			] as SessionItem[],
		},
		{
			id: "r",
			parentSessionId: "root",
			harness: "codex",
			listedModelId: "gpt-6-luna",
			agentRole: "researcher" as const,
			items: [],
		},
	];

	it("counts handoffs, rounds, lead edits, applied patches, spend and time", () => {
		const metrics = fusionTurnMetrics({ rootId: "root", sessions });
		expect(metrics).toMatchObject({
			sidekicks: 1,
			handoffs: 2,
			sidekickRounds: 2,
			agentSends: 1,
			writersStarted: 1,
			leadEdits: 3,
			patchesApplied: 2,
			sidekickBusyMinutes: 10,
			explorationHandoffs: 0,
			leadReads: 1,
			sidekickReads: 2,
			signals: { "same-check-failed": 1 },
			switches: 0,
			sidekickTurns: 1,
		});
		expect(metrics.lead.tokens).toBe(105_000);
		expect(metrics.sidekick.tokens).toBe(420_000);
		expect(metrics.others.tokens).toBe(0);
		const line = fusionMetricsLine(metrics, 1200);
		expect(line).toContain("handoffs 2 · rounds 2");
		expect(line).toContain("lead edits 3 · patches applied 2");
		expect(line).toContain("sidekick busy 10.0m of 20.0m");
		expect(line).toContain("explore 0 · reads lead 1/sidekick 2");
		expect(line).toContain("signals same-check-failed 1");
	});

	it("records the pair-tuning signals: edit rate, rework, failures, pushback and classifier decisions", () => {
		const decision = (
			value: "on_track" | "hand_back" | "switch_model",
			source: "classifier" | "rules",
			costUsd: number | null,
		) => ({
			point: "round" as const,
			round: 1,
			decision: value,
			reason: "r",
			source,
			inputsHash: "h",
			latencyMs: 100,
			tokens: 10,
			costUsd,
			planBilled: true,
			at: at(1),
		});
		let tuned = newSidekickState({ tokens: 2_000_000 }, at(0), {
			requestKey: "u1",
		});
		tuned = endSidekickRound(tuned, {
			now: at(1),
			outcome: "finished",
			patchFiles: 1,
		});
		tuned = recordSidekickDecision(
			tuned,
			decision("on_track", "classifier", 0.001),
		);
		// Feedback in the same request: a rework round, which fails.
		tuned = beginSidekickRound(tuned, {
			now: at(2),
			steps: 1,
			tokens: 1,
			requestKey: "u1",
		});
		tuned = endSidekickRound(tuned, {
			now: at(3),
			outcome: "budget exhausted",
			patchFiles: 0,
			pushback: true,
		});
		tuned = recordSidekickDecision(tuned, decision("switch_model", "rules", 0));
		tuned = markSidekickSwitch(tuned, {
			to: "codex:gpt-6.1-sol",
			reason: "r",
			round: 2,
			at: at(3),
		});
		// The next request's first build round is not rework.
		tuned = beginSidekickRound(tuned, {
			now: at(4),
			steps: 2,
			tokens: 2,
			requestKey: "u2",
		});
		expect(sidekickSwitchDue(tuned)).toBe(true);
		tuned = completeSidekickSwitch(tuned, {
			from: "gpt-6-luna",
			to: "gpt-6.1-sol",
			reason: "r",
			round: 3,
			trigger: "pending",
			compacted: true,
			at: at(4),
		});
		expect(sidekickSwitchDue(tuned)).toBe(false);
		expect(tuned.model).toBe("gpt-6.1-sol");
		tuned = endSidekickRound(tuned, {
			now: at(5),
			outcome: "finished",
			patchFiles: 1,
		});
		tuned = recordSidekickDecision(
			tuned,
			decision("hand_back", "classifier", null),
		);
		const metrics = fusionTurnMetrics({
			rootId: "root",
			sessions: [
				{ ...sessions[0], items: [call("edit", { path: "a.ts" }, "1")] },
				{
					...sessions[1],
					agentBudget: { ...sessions[1].agentBudget, sidekick: tuned },
					items: [
						call("edit", { path: "b.ts" }, "s1"),
						call("write", { path: "c.ts" }, "s2"),
						call("edit", { path: "d.ts" }, "s3"),
					],
				},
			] as typeof sessions,
		});
		expect(metrics).toMatchObject({
			leadEdits: 1,
			sidekickEdits: 3,
			leadEditRate: 0.25,
			reworkRounds: 1,
			sidekickFailures: 1,
			pushbacks: 1,
			switches: 1,
			decisions: { on_track: 1, switch_model: 1, hand_back: 1 },
			classifierFallbacks: 1,
			classifierMeanMs: 100,
			classifierUsd: null,
		});
		const line = fusionMetricsLine(metrics);
		expect(line).toContain(
			"lead edit rate 25% · rework 1 · failures 1 · pushback 1",
		);
		expect(line).toContain(
			"decisions on_track 1/switch_model 1/hand_back 1 (rules 1) 100ms ?",
		);
		expect(line).toContain("switches 1");
	});

	it("tells a report that pushes back on its brief", () => {
		expect(
			reportPushesBack("Done.\n\nPushback: the cache belongs in db.ts."),
		).toBe(true);
		expect(reportPushesBack("**Pushback:** wrong file")).toBe(true);
		expect(reportPushesBack("I disagree with the brief's plan.")).toBe(true);
		expect(reportPushesBack("Done: make test passes.")).toBe(false);
	});

	it("is all zeros for a builder that never delegated", () => {
		const metrics = fusionTurnMetrics({
			rootId: "root",
			sessions: [{ ...sessions[0], items: [] } as (typeof sessions)[0]],
		});
		expect(metrics).toMatchObject({
			sidekicks: 0,
			handoffs: 0,
			leadEdits: 0,
			patchesApplied: 0,
		});
	});
});
