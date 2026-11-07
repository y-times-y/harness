import { isInternalChildTaskMessage } from "./child-task-activity";
import { CODE_MODE_TOOL, codeModeResult } from "./code-mode";
import type { FusionPairProfile } from "./fusion-pairs";
import { leanToolNames } from "./harness-model-profile";
import { sessionBilling } from "./model-pricing";
import { type SessionItem, sessionItemsFromUnknown } from "./session-item";
import type {
	SidekickDecision,
	SidekickDecisionRecord,
} from "./sidekick-classifier";
import type {
	RoundEvidence,
	SidekickRoundKind,
	SidekickSignal,
	SidekickSignalKind,
} from "./sidekick-signals";
import type {
	SubagentBudget,
	SubagentOutcome,
	SubagentRole,
	SubagentUsed,
} from "./subagent";
import { agentSpend, totalSpend } from "./subagent-usage";

/**
 * Lead mode fusion (harness variant lead=fusion): the
 * root builder is a lead that plans, briefs, reviews and answers the user;
 * its writer is a persistent sidekick. The flow is: the
 * user's task, the sidekick's code exploration (started by the harness
 * before the lead's first model call), file snippets, the lead's plan, the
 * sidekick's code, tests and lint fixes, the lead's review, its requested
 * edits, the sidekick's fixes, the final code.
 *
 * The two share one workspace: the sidekick works directly in the lead's
 * checkout on the lead's VM, as an ordinary writer (no fork, no sync, no
 * patch). One writes at a time: while a round runs the lead waits (its turn
 * makes no model call and cannot complete), and after the round it reviews
 * the changes in place (`git diff` against the round's start snapshot).
 * The sidekick keeps its session (context, provider cache) across rounds:
 * each brief or piece of feedback the lead sends while it is idle starts a
 * new round.
 *
 * The sidekick lives as long as the chat: idle between the user's messages,
 * it takes the lead's next brief in a later turn with its context intact.
 * It is retired when the lead stops it, the lead's turn fails or is
 * cancelled, it used a turn's rounds, or it stayed idle past its TTL
 * (sidekickIdleTtlMinutes; the maintenance sweep; idle it costs nothing,
 * since it holds no VM of its own). The round cap counts per user request.
 *
 * These are the pure rules: the state kept in the sidekick's agent_budget,
 * its per-round budget, and the per-turn metrics.
 */

/** Rounds one sidekick may run per user request (its first brief included). */
export const SIDEKICK_MAX_ROUNDS = 6;
/** Restarts of a failed writer per user request, each a fresh session with a handoff. */
export const SIDEKICK_MAX_RESTARTS = 2;
/** Rounds kept in the state (metrics across a chat's turns). */
const KEPT_ROUNDS = 24;
/** Minutes an idle sidekick waits for the lead's next brief. */
export const SIDEKICK_IDLE_TTL_MINUTES = 30;

/** The idle TTL: YTIMESY_SIDEKICK_IDLE_MINUTES when set to a positive number. */
export function sidekickIdleTtlMinutes(
	env: Readonly<Record<string, string | undefined>> = process.env,
) {
	const value = Number(env.YTIMESY_SIDEKICK_IDLE_MINUTES);
	return Number.isFinite(value) && value > 0
		? value
		: SIDEKICK_IDLE_TTL_MINUTES;
}
/** Below this a round cannot do useful work. */
const MIN_ROUND_TOKENS = 50_000;

export type SidekickRound = {
	readonly n: number;
	readonly startedAt: string;
	readonly endedAt?: string;
	readonly outcome?: SubagentOutcome;
	/** Files the round changed in the shared checkout (0: no changes). */
	readonly patchFiles?: number;
	/** The checkout at the round's start, snapshotted as a commit (its changes are diffed against it). */
	readonly base?: string;
	/** The checkout at the round's end, snapshotted as a commit. */
	readonly end?: string;
	/** explore: read and report snippets, change no files; build (default): change files. */
	readonly kind?: SidekickRoundKind;
	/** Its failed checks and errors, compared by the next round's signals. */
	readonly evidence?: RoundEvidence;
	/** Hand-back signals fired at its end (src/domain/sidekick-signals.ts). */
	readonly signals?: readonly SidekickSignal[];
	/** Which of the chat's user requests it served (1: the first). */
	readonly request?: number;
	/** Its report argued against the brief (pair tuning: pushback occurrences). */
	readonly pushback?: boolean;
};

/** A model switch the classifier asked for, carried out at the sidekick's next compaction. */
export type SidekickPendingSwitch = {
	/** roleModels.writerEscalation's spec, e.g. codex:gpt-6.1-sol. */
	readonly to: string;
	readonly reason: string;
	/** The round whose decision asked for it. */
	readonly round: number;
	readonly at: string;
};

/** A switch carried out: the same session continued on another model from its compacted context. */
export type SidekickSwitch = {
	readonly from: string;
	readonly to: string;
	readonly reason: string;
	/** The round it happened in (its start, or mid-round). */
	readonly round: number;
	/** pending: decided at a round's end; compaction: decided by the classifier at this compaction. */
	readonly trigger: "pending" | "compaction";
	/** False when the compaction failed and the switch went ahead on the provider-neutral history. */
	readonly compacted: boolean;
	readonly at: string;
};

export type SidekickState = {
	readonly maxRounds: number;
	/** Tokens one round may spend (in the budget's price basis). */
	readonly roundTokens: number;
	/** The current (or last) round, from 1. */
	readonly round: number;
	readonly roundStartedAt: string;
	/** agent_steps and budget tokens already used when the round started. */
	readonly roundStartSteps: number;
	readonly roundStartTokens: number;
	readonly rounds: readonly SidekickRound[];
	/** Set when it may take no more rounds (stopped, out of rounds, idle too long, the lead's turn failed). */
	readonly retired?: { readonly at: string; readonly reason: string };
	/** The lead/sidekick pair's tuning (src/domain/fusion-pairs.ts). */
	readonly pair?: FusionPairProfile;
	/** The sidekick's model when it started. */
	readonly model?: string;
	/** The lead's user request (its message id) the current rounds serve. */
	readonly requestKey?: string;
	/** The first round of the current user request (the round cap counts from it). */
	readonly turnFirstRound?: number;
	/** User requests this sidekick served (1 in a single-message chat). */
	readonly turns?: number;
	/** Classifier decisions (rounds' ends and compactions), oldest first. */
	readonly decisions?: readonly SidekickDecisionRecord[];
	/** Set while a switch_model waits for the sidekick's next compaction. */
	readonly pendingSwitch?: SidekickPendingSwitch;
	/** Model switches carried out. */
	readonly switches?: readonly SidekickSwitch[];
	/** The turn whose switch was dropped: it neither switches nor compacts for one again. */
	readonly switchBlockedTurn?: string;
};

export function newSidekickState(
	budget: Pick<SubagentBudget, "tokens">,
	now: string,
	options: {
		readonly pair?: FusionPairProfile;
		readonly model?: string;
		readonly requestKey?: string;
		readonly kind?: SidekickRoundKind;
		/** The checkout snapshot at round 1's start. */
		readonly base?: string;
	} = {},
): SidekickState {
	return {
		...(options.pair ? { pair: options.pair } : {}),
		...(options.model ? { model: options.model } : {}),
		...(options.requestKey ? { requestKey: options.requestKey } : {}),
		turnFirstRound: 1,
		turns: 1,
		maxRounds: SIDEKICK_MAX_ROUNDS,
		roundTokens: Math.max(
			Math.min(budget.tokens, MIN_ROUND_TOKENS),
			Math.floor(budget.tokens / 2),
		),
		round: 1,
		roundStartedAt: now,
		roundStartSteps: 0,
		roundStartTokens: 0,
		rounds: [
			{
				n: 1,
				startedAt: now,
				request: 1,
				...(options.kind ? { kind: options.kind } : {}),
				...(options.base ? { base: options.base } : {}),
			},
		],
	};
}

type SidekickSession = {
	readonly agentRole?: SubagentRole | null;
	readonly agentBudget?: SubagentBudget | null;
};

export function sidekickState(session: SidekickSession | null | undefined) {
	return session?.agentRole === "writer"
		? (session.agentBudget?.sidekick ?? null)
		: null;
}

/** A sidekick that may still take rounds. */
export function isActiveSidekick(session: SidekickSession | null | undefined) {
	const state = sidekickState(session);
	return !!state && !state.retired;
}

/** The current round's number within its user request (from 1). */
export function sidekickTurnRound(state: SidekickState) {
	return state.round - (state.turnFirstRound ?? 1) + 1;
}

/**
 * Rounds left to start in this user request; a new request (another
 * `requestKey`) starts a fresh count.
 */
export function sidekickRoundsLeft(state: SidekickState, requestKey?: string) {
	if (requestKey && state.requestKey && requestKey !== state.requestKey)
		return state.maxRounds;
	return Math.max(0, state.maxRounds - sidekickTurnRound(state));
}

/** "round 2/6" in the chat's first request, "round 8 (2/6 this turn)" later. */
export function sidekickRoundLabel(state: SidekickState) {
	return roundLabel(state.round, state.turnFirstRound ?? 1, state.maxRounds);
}

function roundLabel(round: number, turnFirstRound: number, maxRounds: number) {
	return turnFirstRound <= 1
		? `round ${round}/${maxRounds}`
		: `round ${round} (${round - turnFirstRound + 1}/${maxRounds} this turn)`;
}

/** When the sidekick went idle (its last round's end), if it is idle. */
export function sidekickIdleSince(state: SidekickState) {
	const last = state.rounds.at(-1);
	return last?.n === state.round ? (last.endedAt ?? null) : null;
}

/** The lead's latest user request: its message id, skipping child reports and runtime notes. */
export function latestUserRequestId(items: readonly SessionItem[]) {
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (
			item?.kind === "userMessage" &&
			!isInternalChildTaskMessage(item.text) &&
			!/^(Runtime notice|Peer message from )/.test(item.text)
		)
			return String(item.id);
	}
	return undefined;
}

/**
 * The limits and use a step check compares. An ordinary agent's are its
 * budget and its whole life; a sidekick's steps, minutes and tokens count
 * from the round's start, each round against its own cap. Its rounds are not
 * capped together: SIDEKICK_MAX_ROUNDS per user request bounds them, and the
 * user's usage limits bound the total.
 */
export function subagentBudgetCheck(
	budget: SubagentBudget,
	used: {
		readonly steps: number;
		readonly tokens: number;
		readonly createdAt: string;
	},
	now: number,
): {
	readonly limits: SubagentBudget;
	readonly used: SubagentUsed;
	/** Prefix of the wrap-up reason: a sidekick's names its round. */
	readonly reasonPrefix: string;
} {
	const state = budget.sidekick;
	if (!state)
		return {
			limits: budget,
			used: {
				steps: used.steps,
				minutes: (now - Date.parse(used.createdAt)) / 60_000,
				tokens: used.tokens,
			},
			reasonPrefix: "",
		};
	const { stopAtStep, ...rest } = budget;
	return {
		limits: {
			...rest,
			tokens: state.roundTokens,
			...(stopAtStep === undefined
				? {}
				: { stopAtStep: Math.max(0, stopAtStep - state.roundStartSteps) }),
		},
		used: {
			steps: Math.max(0, used.steps - state.roundStartSteps),
			minutes: (now - Date.parse(state.roundStartedAt)) / 60_000,
			tokens: Math.max(0, used.tokens - state.roundStartTokens),
		},
		reasonPrefix: `round ${state.round}, `,
	};
}

/** The state when the lead starts the next round. */
export function beginSidekickRound(
	state: SidekickState,
	input: {
		readonly now: string;
		readonly steps: number;
		readonly tokens: number;
		/** The checkout snapshot at the round's start. */
		readonly base?: string;
		readonly kind?: SidekickRoundKind;
		/** The lead's current user request; another one than before starts a new turn's count. */
		readonly requestKey?: string;
	},
): SidekickState {
	const n = state.round + 1;
	const newRequest =
		!!input.requestKey &&
		!!state.requestKey &&
		input.requestKey !== state.requestKey;
	const turns = (state.turns ?? 1) + (newRequest ? 1 : 0);
	return {
		...state,
		...(input.requestKey ? { requestKey: input.requestKey } : {}),
		turnFirstRound: newRequest ? n : (state.turnFirstRound ?? 1),
		turns,
		round: n,
		roundStartedAt: input.now,
		roundStartSteps: input.steps,
		roundStartTokens: input.tokens,
		rounds: [
			...state.rounds,
			{
				n,
				startedAt: input.now,
				request: turns,
				...(input.kind ? { kind: input.kind } : {}),
				...(input.base ? { base: input.base } : {}),
			},
		].slice(-KEPT_ROUNDS),
	};
}

/** The state after the round's report; out of rounds retires it. */
export function endSidekickRound(
	state: SidekickState,
	input: {
		readonly now: string;
		readonly outcome: SubagentOutcome;
		readonly patchFiles: number;
		/** The checkout snapshot at the round's end. */
		readonly end?: string;
		readonly evidence?: RoundEvidence;
		readonly signals?: readonly SidekickSignal[];
		readonly pushback?: boolean;
	},
): SidekickState {
	const ended: SidekickState = {
		...state,
		rounds: state.rounds.map((round) =>
			round.n === state.round && !round.endedAt
				? {
						...round,
						endedAt: input.now,
						outcome: input.outcome,
						patchFiles: input.patchFiles,
						...(input.end ? { end: input.end } : {}),
						...(input.evidence ? { evidence: input.evidence } : {}),
						...(input.signals?.length ? { signals: input.signals } : {}),
						...(input.pushback ? { pushback: true } : {}),
					}
				: round,
		),
	};
	return sidekickTurnRound(state) >= state.maxRounds && !state.retired
		? retireSidekickState(ended, "all rounds used", input.now)
		: ended;
}

/** The current round's record. */
export function currentSidekickRound(state: SidekickState) {
	return state.rounds.find((round) => round.n === state.round);
}

/** The round before the current one, if kept. */
export function previousSidekickRound(state: SidekickState) {
	return state.rounds.find((round) => round.n === state.round - 1);
}

export function retireSidekickState(
	state: SidekickState,
	reason: string,
	now: string,
): SidekickState {
	return state.retired ? state : { ...state, retired: { at: now, reason } };
}

/** Where the lead's checkout keeps a round's start (or end) snapshot. */
export function sidekickRoundRef(
	label: string,
	round: number,
	edge: "start" | "end",
) {
	return `refs/ytimesy/sidekick/${label}/round-${round}-${edge}`;
}

/** Decisions kept in the state. */
const KEPT_DECISIONS = 48;

/** The state with one more classifier decision recorded. */
export function recordSidekickDecision(
	state: SidekickState,
	record: SidekickDecisionRecord,
): SidekickState {
	return {
		...state,
		decisions: [...(state.decisions ?? []), record].slice(-KEPT_DECISIONS),
	};
}

/** The state after a switch_model: the switch waits for the next compaction. */
export function markSidekickSwitch(
	state: SidekickState,
	pending: SidekickPendingSwitch,
): SidekickState {
	return { ...state, pendingSwitch: pending };
}

/**
 * Whether the current round must start by compacting the sidekick's
 * context: a switch is pending from an earlier round's decision (switch
 * policy: at the next compaction, and since a short round rarely reaches
 * one, its next round forces one first).
 */
export function sidekickSwitchDue(state: SidekickState, turnId?: string) {
	return (
		!!state.pendingSwitch &&
		!state.retired &&
		state.round > state.pendingSwitch.round &&
		(turnId === undefined || state.switchBlockedTurn !== turnId)
	);
}

/** The state once the sidekick continues on another model. */
export function completeSidekickSwitch(
	state: SidekickState,
	done: SidekickSwitch,
): SidekickState {
	const { pendingSwitch: _, ...rest } = state;
	return {
		...rest,
		model: done.to,
		switches: [...(state.switches ?? []), done],
	};
}

/** A report that argues against its brief (the pushback contract's "Pushback:" or its usual wording). */
export function reportPushesBack(report: string) {
	return (
		/^\s*(?:\*\*)?pushback(?:\*\*)?\s*:/im.test(report) ||
		/\b(?:I disagree|the brief(?:'s)? (?:approach|plan) (?:is|looks|seems) (?:wrong|flawed)|I would instead|instead I would|I recommend instead)\b/i.test(
			report,
		)
	);
}

/** Whether the sidekick is in a round: its current round has no report yet. */
export function sidekickRoundOpen(state: SidekickState) {
	return !currentSidekickRound(state)?.endedAt;
}

/**
 * Whether the user request `requestKey` already has an exploration round
 * among these sidekick states (an escalated sidekick's predecessor counts).
 */
export function requestExplored(
	states: readonly SidekickState[],
	requestKey: string,
) {
	return states.some(
		(state) =>
			state.requestKey === requestKey &&
			state.rounds.some(
				(round) =>
					round.kind === "explore" && round.n >= (state.turnFirstRound ?? 1),
			),
	);
}

/** Appended to an exploration round's brief: what to return (lead mode fusion). */
export const SIDEKICK_EXPLORE_NOTE =
	"Exploration round: change no files. Find the code this task touches and report in this format. Files: each relevant path with its line ranges and why it matters. Snippets: the key code quoted with line numbers, only what a plan needs. Commands: how to build and run the checks, and what they print now. Open questions: what you could not settle.";

/** Opens the exploration brief the harness writes from the user's request. */
export const HARNESS_EXPLORE_HEADING =
	"Exploration round for Main, started by the harness before Main plans.";
/** The longest part of the user's request an exploration brief quotes. */
const EXPLORE_REQUEST_MAX = 5_000;

/**
 * The exploration brief the harness gives the sidekick when a user request
 * starts: the request itself and what to return.
 */
export function harnessExplorationBrief(requestText: string) {
	const request = requestText.trim();
	const quoted =
		request.length > EXPLORE_REQUEST_MAX
			? `${request.slice(0, EXPLORE_REQUEST_MAX)}\n[request truncated]`
			: request;
	return [
		HARNESS_EXPLORE_HEADING,
		`The user's request:\n<request>\n${quoted}\n</request>`,
		"Find the code this request touches so Main can plan without reading it: the relevant files, the key snippets with their line ranges, how to build and run the checks (and what they print now), what the change will touch, and what is still open.",
		SIDEKICK_EXPLORE_NOTE,
	].join("\n\n");
}

/** The text the sidekick receives at a new round's start: the round, then the lead's message. */
export function sidekickRoundMessage(input: {
	readonly round: number;
	readonly maxRounds: number;
	readonly message: string;
	/** The first round of the current user request (1: the chat's first). */
	readonly turnFirstRound?: number;
	readonly kind?: SidekickRoundKind;
}) {
	const first = input.turnFirstRound ?? 1;
	const heading =
		first <= 1
			? `Round ${input.round}/${input.maxRounds} from Main.`
			: `Round ${input.round} from Main (${input.round - first + 1}/${input.maxRounds} for the user's new request).`;
	return `${heading} You work in Main's checkout as it is now (Main may have changed or reverted your earlier work); Main does not edit while you work and reviews this round's changes in place.\n\n${input.message.trim()}${input.kind === "explore" ? `\n\n${SIDEKICK_EXPLORE_NOTE}` : ""}`;
}

/* ------------------------------------------------------------------ */
/* Per-turn metrics (the hard-set's Fusion block)                      */
/* ------------------------------------------------------------------ */

export type FusionTurnMetrics = {
	readonly sidekicks: number;
	/** Rounds started by the lead: first briefs plus later briefs or feedback. */
	readonly handoffs: number;
	/** Rounds that ended with a report. */
	readonly sidekickRounds: number;
	/** agent_send calls by the lead (rounds, steering and stops). */
	readonly agentSends: number;
	/** Writers started by the lead (the sidekick included). */
	readonly writersStarted: number;
	/** The lead's own file edits (edit/write calls, run_code's included). */
	readonly leadEdits: number;
	/** The lead's commands that applied or merged an agent's patch or ref (0 with a shared checkout). */
	readonly patchesApplied: number;
	readonly lead: FusionSpend;
	readonly sidekick: FusionSpend;
	/** Other children (readers, checkers, other writers). */
	readonly others: FusionSpend;
	/** Minutes the sidekick spent inside rounds (start to report). */
	readonly sidekickBusyMinutes: number;
	/** Exploration rounds (the sidekick explored and returned snippets). Optional: older records lack it. */
	readonly explorationHandoffs?: number;
	/** File reads (read tool calls and cat/sed/head/tail/nl commands) by the lead and by its sidekicks. */
	readonly leadReads?: number;
	readonly sidekickReads?: number;
	/** Hand-back signals fired after rounds, by kind. */
	readonly signals?: Readonly<Partial<Record<SidekickSignalKind, number>>>;
	/** Model switches at compaction (the same sidekick continued on roleModels.writerEscalation). */
	readonly switches?: number;
	/** The most user requests one sidekick served (its lifetime across the chat's turns). */
	readonly sidekickTurns?: number;
	/*
	 * Pair tuning (src/domain/fusion-pairs.ts): what a profile's brief style,
	 * pushback and exploration settings are judged by. Optional: older
	 * records lack them.
	 */
	/** The sidekicks' own file edits (edit/write calls, run_code's included). */
	readonly sidekickEdits?: number;
	/** The lead's share of all file edits: leadEdits / (leadEdits + sidekickEdits); 0 without edits. */
	readonly leadEditRate?: number;
	/** Rework (feedback) rounds: build rounds after the first build round of the same user request. */
	readonly reworkRounds?: number;
	/** Rounds that ended failed or at their budget. */
	readonly sidekickFailures?: number;
	/** Rounds whose report argued against the brief. */
	readonly pushbacks?: number;
	/** Classifier decisions by kind (rounds' ends and compactions). */
	readonly decisions?: Readonly<Partial<Record<SidekickDecision, number>>>;
	/** Decisions the rules made because the classifier failed, timed out or answered badly. */
	readonly classifierFallbacks?: number;
	/** Mean classifier latency per decision, in ms. */
	readonly classifierMeanMs?: number;
	/** The classifier calls' list-price dollars (null when a price is unknown). */
	readonly classifierUsd?: number | null;
};

export type FusionSpend = {
	readonly tokens: number;
	readonly costUsd: number | null;
	readonly estimated: boolean;
};

type MetricsSession = {
	readonly id: string;
	readonly parentSessionId: string | null;
	readonly harness: string;
	readonly listedModelId: string | null;
	readonly items: unknown;
	readonly agentRole?: SubagentRole | null;
	readonly agentBudget?: SubagentBudget | null;
};

const EDIT_TOOLS = new Set<string>(leanToolNames(["write", "edit"]));
const COMMAND_TOOLS = new Set<string>(leanToolNames(["command"]));
const READ_TOOLS = new Set<string>(leanToolNames(["read"]));
/** A shell command that prints a file (the codex shape reads through its shell). */
const PRINTS_FILE =
	/^\s*(?:cd\s+\S+\s*&&\s*)?(?:cat|sed\s+-n|head|tail|nl|less)\s/;

function commandText(input: string) {
	try {
		const parsed = JSON.parse(input) as { command?: unknown; cmd?: unknown };
		const command = parsed.command ?? parsed.cmd;
		return typeof command === "string" ? command : input;
	} catch {
		return input;
	}
}

/** File reads among a session's tool calls. */
function fileReads(calls: readonly { tool: string; input: string }[]) {
	return calls.filter(
		(call) =>
			READ_TOOLS.has(call.tool) ||
			((COMMAND_TOOLS.has(call.tool) || call.tool === "bash") &&
				PRINTS_FILE.test(commandText(call.input))),
	).length;
}
/** git apply/am of an agent patch, or merge/cherry-pick/checkout of an agent ref. */
const APPLIES_AGENT_WORK =
	/git\s+(?:-C\s+\S+\s+)?(?:apply|am)\b[^\n]*\.ytimesy\/agents\/|git\s+(?:-C\s+\S+\s+)?(?:merge|cherry-pick|checkout|restore|read-tree)\b[^\n]*refs\/ytimesy\/agents\//;

/** Tool calls of a session's items, run_code's inner calls included. */
function toolCalls(items: readonly SessionItem[]) {
	const calls: { tool: string; input: string }[] = [];
	for (const item of items) {
		if (item.kind === "fileChange") calls.push({ tool: "edit", input: "" });
		if (item.kind === "commandExecution")
			calls.push({ tool: "bash", input: item.command });
		if (item.kind !== "dynamicToolCall") continue;
		calls.push({ tool: item.tool, input: item.input ?? "" });
		if (item.tool === CODE_MODE_TOOL)
			for (const call of codeModeResult(item)?.calls ?? [])
				if (call && typeof call.tool === "string")
					calls.push({
						tool: call.tool,
						input:
							typeof call.input === "string"
								? call.input
								: JSON.stringify(call.input ?? ""),
					});
	}
	return calls;
}

function fusionSpend(sessions: readonly MetricsSession[]): FusionSpend {
	const spend = totalSpend(
		sessions.map((session) =>
			agentSpend({
				items: sessionItemsFromUnknown(session.items),
				billing: sessionBilling(session),
			}),
		),
	);
	return {
		tokens: spend.tokens,
		costUsd: spend.costUsd,
		estimated: spend.planBilled,
	};
}

/** What lead mode did in one turn's session tree (the root is the lead). */
export function fusionTurnMetrics(input: {
	readonly rootId: string;
	readonly sessions: readonly MetricsSession[];
}): FusionTurnMetrics {
	const root = input.sessions.find((session) => session.id === input.rootId);
	const children = input.sessions.filter(
		(session) => session.id !== input.rootId,
	);
	const sidekicks = children.filter((session) => sidekickState(session));
	const calls = toolCalls(sessionItemsFromUnknown(root?.items));
	let handoffs = 0;
	let ended = 0;
	let busyMs = 0;
	let explorationHandoffs = 0;
	let switches = 0;
	let sidekickTurns = 0;
	let reworkRounds = 0;
	let sidekickFailures = 0;
	let pushbacks = 0;
	let classifierFallbacks = 0;
	let classifierMs = 0;
	let classifierUsd: number | null = 0;
	const decisions: Partial<Record<SidekickDecision, number>> = {};
	const signals: Partial<Record<SidekickSignalKind, number>> = {};
	for (const session of sidekicks) {
		const state = sidekickState(session) as SidekickState;
		switches += state.switches?.length ?? 0;
		sidekickTurns = Math.max(sidekickTurns, state.turns ?? 1);
		for (const record of state.decisions ?? []) {
			decisions[record.decision] = (decisions[record.decision] ?? 0) + 1;
			if (record.source === "rules") classifierFallbacks += 1;
			classifierMs += record.latencyMs;
			classifierUsd =
				classifierUsd === null || record.costUsd === null
					? null
					: classifierUsd + record.costUsd;
		}
		const built = new Set<number>();
		for (const round of state.rounds) {
			handoffs += 1;
			if (round.kind === "explore") explorationHandoffs += 1;
			else {
				const request = round.request ?? 1;
				if (built.has(request)) reworkRounds += 1;
				built.add(request);
			}
			if (round.pushback) pushbacks += 1;
			if (round.outcome === "failed" || round.outcome === "budget exhausted")
				sidekickFailures += 1;
			for (const signal of round.signals ?? [])
				signals[signal.kind] = (signals[signal.kind] ?? 0) + 1;
			if (!round.endedAt) continue;
			ended += 1;
			busyMs += Math.max(
				0,
				Date.parse(round.endedAt) - Date.parse(round.startedAt),
			);
		}
	}
	const leadEdits = calls.filter((call) => EDIT_TOOLS.has(call.tool)).length;
	const sidekickEdits = sidekicks.reduce(
		(total, session) =>
			total +
			toolCalls(sessionItemsFromUnknown(session.items)).filter((call) =>
				EDIT_TOOLS.has(call.tool),
			).length,
		0,
	);
	const decided = Object.values(decisions).reduce(
		(total, value) => total + (value ?? 0),
		0,
	);
	return {
		sidekicks: sidekicks.length,
		handoffs,
		sidekickRounds: ended,
		agentSends: calls.filter((call) => call.tool === "agent_send").length,
		writersStarted: calls.filter(
			(call) =>
				call.tool === "agent" && /"role"\s*:\s*"writer"/.test(call.input),
		).length,
		leadEdits,
		patchesApplied: calls.filter(
			(call) =>
				(COMMAND_TOOLS.has(call.tool) || call.tool === "bash") &&
				APPLIES_AGENT_WORK.test(call.input.replaceAll('\\"', '"')),
		).length,
		lead: fusionSpend(root ? [root] : []),
		sidekick: fusionSpend(sidekicks),
		others: fusionSpend(
			children.filter((session) => !sidekicks.includes(session)),
		),
		sidekickBusyMinutes: busyMs / 60_000,
		explorationHandoffs,
		leadReads: fileReads(calls),
		sidekickReads: sidekicks.reduce(
			(total, session) =>
				total + fileReads(toolCalls(sessionItemsFromUnknown(session.items))),
			0,
		),
		signals,
		switches,
		sidekickTurns,
		sidekickEdits,
		leadEditRate:
			leadEdits + sidekickEdits ? leadEdits / (leadEdits + sidekickEdits) : 0,
		reworkRounds,
		sidekickFailures,
		pushbacks,
		decisions,
		classifierFallbacks,
		classifierMeanMs: decided ? classifierMs / decided : 0,
		classifierUsd,
	};
}

const usd = (value: number | null) =>
	value === null ? "?" : `$${value.toFixed(value < 1 ? 3 : 2)}`;
const k = (tokens: number) =>
	tokens >= 1_000_000
		? `${(tokens / 1_000_000).toFixed(1)}M`
		: `${Math.round(tokens / 1000)}k`;

/** One run's Fusion line: handoffs, rounds, lead edits, patches applied, spend split, time. */
export function fusionMetricsLine(
	metrics: FusionTurnMetrics,
	agentSeconds?: number,
) {
	const total = [metrics.lead, metrics.sidekick, metrics.others];
	const known = total.every((spend) => spend.costUsd !== null);
	const sum = known
		? total.reduce((value, spend) => value + (spend.costUsd ?? 0), 0)
		: null;
	const share =
		sum && metrics.sidekick.costUsd !== null
			? ` (${Math.round((metrics.sidekick.costUsd / sum) * 100)}% sidekick)`
			: "";
	return [
		`sidekicks ${metrics.sidekicks}`,
		`handoffs ${metrics.handoffs}`,
		`rounds ${metrics.sidekickRounds}`,
		`agent_send ${metrics.agentSends}`,
		`writers ${metrics.writersStarted}`,
		`lead edits ${metrics.leadEdits}`,
		`patches applied ${metrics.patchesApplied}`,
		`lead ${k(metrics.lead.tokens)} ${usd(metrics.lead.costUsd)}`,
		`sidekick ${k(metrics.sidekick.tokens)} ${usd(metrics.sidekick.costUsd)}${share}`,
		...(metrics.others.tokens
			? [`others ${k(metrics.others.tokens)} ${usd(metrics.others.costUsd)}`]
			: []),
		`sidekick busy ${metrics.sidekickBusyMinutes.toFixed(1)}m${agentSeconds ? ` of ${(agentSeconds / 60).toFixed(1)}m` : ""}`,
		...(metrics.explorationHandoffs === undefined
			? []
			: [
					`explore ${metrics.explorationHandoffs}`,
					`reads lead ${metrics.leadReads ?? 0}/sidekick ${metrics.sidekickReads ?? 0}`,
				]),
		...(signalsText(metrics) ? [`signals ${signalsText(metrics)}`] : []),
		...(metrics.switches ? [`switches ${metrics.switches}`] : []),
		...((metrics.sidekickTurns ?? 1) > 1
			? [`sidekick turns ${metrics.sidekickTurns}`]
			: []),
		...(metrics.leadEditRate === undefined
			? []
			: [
					`lead edit rate ${Math.round(metrics.leadEditRate * 100)}%`,
					`rework ${metrics.reworkRounds ?? 0}`,
					`failures ${metrics.sidekickFailures ?? 0}`,
					`pushback ${metrics.pushbacks ?? 0}`,
				]),
		...(decisionsText(metrics)
			? [
					`decisions ${decisionsText(metrics)}${metrics.classifierFallbacks ? ` (rules ${metrics.classifierFallbacks})` : ""} ${Math.round(metrics.classifierMeanMs ?? 0)}ms ${usd(metrics.classifierUsd ?? null)}`,
				]
			: []),
	].join(" · ");
}

function decisionsText(metrics: FusionTurnMetrics) {
	return Object.entries(metrics.decisions ?? {})
		.filter(([, count]) => count)
		.map(([kind, count]) => `${kind} ${count}`)
		.join("/");
}

function signalsText(metrics: FusionTurnMetrics) {
	return Object.entries(metrics.signals ?? {})
		.filter(([, count]) => count)
		.map(([kind, count]) => `${kind} ${count}`)
		.join("/");
}

/** Means over runs of one arm, for the Fusion block's arm line. */
export function fusionMetricsMeans(list: readonly FusionTurnMetrics[]) {
	const mean = (pick: (metrics: FusionTurnMetrics) => number) =>
		list.length
			? list.reduce((total, metrics) => total + pick(metrics), 0) / list.length
			: 0;
	const meanUsd = (pick: (metrics: FusionTurnMetrics) => number | null) =>
		list.some((metrics) => pick(metrics) === null)
			? null
			: mean((metrics) => pick(metrics) as number);
	return {
		runs: list.length,
		handoffs: mean((metrics) => metrics.handoffs),
		sidekickRounds: mean((metrics) => metrics.sidekickRounds),
		leadEdits: mean((metrics) => metrics.leadEdits),
		patchesApplied: mean((metrics) => metrics.patchesApplied),
		leadUsd: meanUsd((metrics) => metrics.lead.costUsd),
		sidekickUsd: meanUsd((metrics) => metrics.sidekick.costUsd),
		sidekickBusyMinutes: mean((metrics) => metrics.sidekickBusyMinutes),
		explorationHandoffs: mean((metrics) => metrics.explorationHandoffs ?? 0),
		leadReads: mean((metrics) => metrics.leadReads ?? 0),
		signals: mean((metrics) =>
			Object.values(metrics.signals ?? {}).reduce(
				(total, count) => total + (count ?? 0),
				0,
			),
		),
		leadEditRate: mean((metrics) => metrics.leadEditRate ?? 0),
		reworkRounds: mean((metrics) => metrics.reworkRounds ?? 0),
		sidekickFailures: mean((metrics) => metrics.sidekickFailures ?? 0),
		pushbacks: mean((metrics) => metrics.pushbacks ?? 0),
		handBacks: mean((metrics) => metrics.decisions?.hand_back ?? 0),
		switches: mean((metrics) => metrics.switches ?? 0),
		classifierFallbacks: mean((metrics) => metrics.classifierFallbacks ?? 0),
	};
}

export function fusionMeansLine(means: ReturnType<typeof fusionMetricsMeans>) {
	return `${means.runs} run(s), per run: handoffs ${means.handoffs.toFixed(1)} · rounds ${means.sidekickRounds.toFixed(1)} · lead edits ${means.leadEdits.toFixed(1)} · patches applied ${means.patchesApplied.toFixed(1)} · lead ${usd(means.leadUsd)} · sidekick ${usd(means.sidekickUsd)} · sidekick busy ${means.sidekickBusyMinutes.toFixed(1)}m · explore ${means.explorationHandoffs.toFixed(1)} · lead reads ${means.leadReads.toFixed(1)} · signals ${means.signals.toFixed(1)} · lead edit rate ${Math.round(means.leadEditRate * 100)}% · rework ${means.reworkRounds.toFixed(1)} · failures ${means.sidekickFailures.toFixed(1)} · pushback ${means.pushbacks.toFixed(1)} · hand_back ${means.handBacks.toFixed(1)} · switches ${means.switches.toFixed(1)} · classifier fallbacks ${means.classifierFallbacks.toFixed(1)}`;
}

/* ------------------------------------------------------------------ */
/* Restart with a handoff (lead=fusion)                                */
/* ------------------------------------------------------------------ */

/** The most characters of each part a handoff quotes. */
const HANDOFF_PART_MAX = 3_000;

const clip = (text: string) => {
	const trimmed = text.trim();
	return trimmed.length > HANDOFF_PART_MAX
		? `[...cut...]\n${trimmed.slice(-HANDOFF_PART_MAX)}`
		: trimmed;
};

/** The last thing an agent said in its session (its report or progress note). */
export function lastAgentText(items: readonly SessionItem[]) {
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (item?.kind === "agentMessage" && item.text.trim()) return item.text;
	}
	return "";
}

/**
 * The brief a restarted writer gets: a fresh session, so it carries what
 * the failed one was asked, what it last said and where its changes are,
 * then the lead's new message. Kept short: the new writer reads the
 * checkout itself.
 */
export function sidekickHandoffBrief(input: {
	readonly previous: string;
	readonly reason: string;
	readonly lastBrief?: string;
	readonly lastReport?: string;
	/** `git status --short` lines, or a diff command for its changes. */
	readonly changes?: string;
	readonly message: string;
}) {
	return [
		`Handoff: you replace writer ${input.previous}, which stopped (${input.reason}). Its work so far is in the checkout; build on it, do not start over unless it is wrong.`,
		input.lastBrief?.trim() ? `Its last brief:\n${clip(input.lastBrief)}` : "",
		input.lastReport?.trim()
			? `Its last message:\n${clip(input.lastReport)}`
			: "It left no report.",
		input.changes?.trim()
			? `Changes in the checkout:\n${clip(input.changes)}`
			: "",
		`Main's brief for you:\n${input.message.trim()}`,
	]
		.filter(Boolean)
		.join("\n\n");
}

/** Sidekicks retired while serving `requestKey` (restarts already used for it). */
export function sidekickRestartsUsed(
	states: readonly SidekickState[],
	requestKey: string | undefined,
) {
	return requestKey
		? states.filter((state) => state.retired && state.requestKey === requestKey)
				.length
		: 0;
}
