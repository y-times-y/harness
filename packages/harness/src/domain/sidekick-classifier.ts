import { modelName } from "./fusion-pairs";
import type { RoleModel, RoleModels } from "./role-models";
import type { SidekickRoundKind, SidekickSignal } from "./sidekick-signals";
import { sidekickStuckReasons, warrantsEscalation } from "./sidekick-signals";
import type { SubagentOutcome } from "./subagent";

/**
 * Lead mode fusion's lightweight classifier. After each
 * sidekick round, and at each compaction of the sidekick's context, a small
 * model (roleModels.classifier, default gpt-6-luna at low effort) reads a
 * short summary of the round and answers one of three decisions:
 *
 * - on_track: nothing to do;
 * - hand_back: the lead's next request carries a notice to re-brief or take over;
 * - switch_model: the sidekick moves to roleModels.writerEscalation at its
 *   next compaction (src/server/services/sidekick-model-switch.ts).
 *
 * The deterministic signals (src/domain/sidekick-signals.ts) are features of
 * the summary and the fallback when the classifier fails or times out.
 * These are the pure parts: the prompt, the summary, the reply's parsing,
 * the rules and the records kept in the sidekick's state.
 */

export const SIDEKICK_DECISIONS = [
	"on_track",
	"hand_back",
	"switch_model",
] as const;
export type SidekickDecision = (typeof SIDEKICK_DECISIONS)[number];

/** roleModels.classifier when unset. */
export const DEFAULT_CLASSIFIER_MODEL: RoleModel = {
	model: "codex:gpt-6-luna",
	effort: "low",
};

/** A classifier call slower than this falls back to the rules. */
export const CLASSIFIER_TIMEOUT_MS = 20_000;

/** YTIMESY_SIDEKICK_CLASSIFIER_TIMEOUT_MS when set to a positive number. */
export function classifierTimeoutMs(
	env: Readonly<Record<string, string | undefined>> = process.env,
) {
	const value = Number(env.YTIMESY_SIDEKICK_CLASSIFIER_TIMEOUT_MS);
	return Number.isFinite(value) && value > 0 ? value : CLASSIFIER_TIMEOUT_MS;
}

/** When the classifier runs: a round's end, or a compaction of the sidekick's context mid-round. */
export type ClassifierPoint = "round" | "compaction";

export type ClassifierInput = {
	readonly point: ClassifierPoint;
	readonly round: number;
	readonly roundKind: SidekickRoundKind;
	/** The sidekick's model now. */
	readonly model: string;
	/** The lead's brief or feedback that started the round. */
	readonly brief: string;
	/** The round's report (its latest text at a compaction). */
	readonly report: string;
	readonly commands: readonly {
		readonly command: string;
		readonly exitCode: number;
	}[];
	/** The round's patch: changed files and line counts (absent mid-round). */
	readonly diff?: {
		readonly files: readonly string[];
		readonly added: number;
		readonly removed: number;
	};
	readonly outcome?: SubagentOutcome;
	readonly signals: readonly SidekickSignal[];
	/** Whether roleModels.writerEscalation offers another model; without it switch_model means hand_back. */
	readonly canSwitch: boolean;
};

const BRIEF_MAX = 1_500;
const REPORT_MAX = 2_000;
const COMMANDS_MAX = 12;
const FILES_MAX = 20;
const REASON_MAX = 300;

/** Heads the classifier's input; the rehearsal's scripted model recognizes it. */
export const CLASSIFIER_MARKER = "Sidekick round summary for classification.";

export const CLASSIFIER_INSTRUCTIONS = `You classify the progress of a coding sidekick: a cheaper agent that implements what a lead agent briefs it to do, one round per brief. You read one round's summary and answer with JSON only, no prose and no code fence: {"decision": "on_track" | "hand_back" | "switch_model", "reason": "<one short sentence>"}.
- on_track: the round made progress toward its brief (files changed as asked, checks pass or fail for a new reason it is working on), or it was an exploration round that returned findings.
- hand_back: the lead should act: the brief is ambiguous or impossible as written, the sidekick asks a question or reports a blocker only the lead can settle, or it ran out of budget or rounds.
- switch_model: the sidekick is stuck in a way a stronger model would likely get past: it repeats the same failing check or error, changes nothing in a build round, or its report shows it does not understand the problem. Answer switch_model only when "canSwitch" is true; otherwise answer hand_back.
"signals" are deterministic hints computed by the runtime (same-check-failed, same-error, no-file-change, round-budget); weigh them, they are not decisions.`;

const clip = (text: string, max: number) =>
	text.length > max ? `${text.slice(0, max)}…` : text;

/** The classifier's user message: the marker, then the round as JSON. */
export function classifierMessage(input: ClassifierInput) {
	const summary = {
		point: input.point,
		round: input.round,
		roundKind: input.roundKind,
		sidekickModel: input.model,
		brief: clip(input.brief.trim(), BRIEF_MAX),
		report: clip(input.report.trim(), REPORT_MAX),
		commands: input.commands.slice(-COMMANDS_MAX).map((entry) => ({
			command: clip(entry.command, 200),
			exit: entry.exitCode,
		})),
		...(input.diff
			? {
					diff: {
						files: input.diff.files.slice(0, FILES_MAX),
						added: input.diff.added,
						removed: input.diff.removed,
					},
				}
			: {}),
		...(input.outcome ? { outcome: input.outcome } : {}),
		signals: input.signals.map((signal) => `${signal.kind}: ${signal.detail}`),
		canSwitch: input.canSwitch,
	};
	return `${CLASSIFIER_MARKER}\n${JSON.stringify(summary)}`;
}

export type ClassifierAnswer = {
	readonly decision: SidekickDecision;
	readonly reason: string;
};

/** The reply as a decision, or null unless it is exactly the JSON asked for. */
export function parseClassifierReply(text: string): ClassifierAnswer | null {
	let value: unknown;
	try {
		value = JSON.parse(text.trim());
	} catch {
		return null;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const { decision, reason } = value as Record<string, unknown>;
	if (
		typeof decision !== "string" ||
		!(SIDEKICK_DECISIONS as readonly string[]).includes(decision) ||
		typeof reason !== "string" ||
		!reason.trim()
	)
		return null;
	return {
		decision: decision as SidekickDecision,
		reason: clip(reason.trim().replaceAll(/\s+/g, " "), REASON_MAX),
	};
}

/** The deterministic decision: the classifier's fallback. */
export function rulesDecision(
	signals: readonly SidekickSignal[],
	canSwitch: boolean,
): ClassifierAnswer {
	if (!signals.length)
		return { decision: "on_track", reason: "no hand-back signal fired" };
	const reason = sidekickStuckReasons(signals);
	return {
		decision:
			warrantsEscalation(signals) && canSwitch ? "switch_model" : "hand_back",
		reason,
	};
}

/** roleModels.writerEscalation's spec when it names a model other than the sidekick's. */
export function sidekickEscalation(
	roleModels: RoleModels | undefined,
	model: string | null | undefined,
) {
	const to = roleModels?.writerEscalation?.model;
	return to && modelName(to) !== modelName(model ?? "") ? to : undefined;
}

/** A switch_model the runtime cannot carry out (no other model) is a hand_back. */
export function applicableDecision(
	answer: ClassifierAnswer,
	canSwitch: boolean,
): ClassifierAnswer {
	return answer.decision === "switch_model" && !canSwitch
		? { ...answer, decision: "hand_back" }
		: answer;
}

/** One decision as the sidekick's state keeps it (the run's record). */
export type SidekickDecisionRecord = {
	readonly point: ClassifierPoint;
	readonly round: number;
	readonly decision: SidekickDecision;
	readonly reason: string;
	/** classifier: the model's answer; rules: the fallback decided. */
	readonly source: "classifier" | "rules";
	/** Why the classifier's answer was not used (failed, timed out, unparsable, no route). */
	readonly fallback?: string;
	/** sha256 of the classifier's input message. */
	readonly inputsHash: string;
	readonly latencyMs: number;
	readonly tokens: number;
	/** List-price dollars of the call (an estimate on a plan-billed route); null when unknown. */
	readonly costUsd: number | null;
	readonly planBilled: boolean;
	/** The classifier's route. */
	readonly model?: string;
	readonly at: string;
};

/** The notice the lead's next request carries for a decision ("" for on_track). */
export function sidekickDecisionNotice(input: {
	readonly label: string;
	readonly decision: SidekickDecision;
	readonly reason: string;
	/** Set for switch_model: the model the sidekick continues on. */
	readonly switchTo?: string;
	/** A thin lead (leadTools=thin) cannot take over: it restarts the writer instead. */
	readonly thin?: boolean;
}) {
	if (input.decision === "on_track") return "";
	const fallback = input.thin
		? "or restart it with a handoff"
		: "or take over and do it yourself";
	const reason = input.reason.replace(/[.\s]+$/, "");
	if (input.decision === "switch_model" && input.switchTo)
		return `Runtime notice: writer ${input.label} looks stuck (${reason}). The runtime switches it to ${input.switchTo} at its next context compaction: its next round starts by compacting its context, and the same writer (session, label ${input.label}) continues on ${input.switchTo} from that summary. Send that round a prescriptive brief (the exact change, file and line, and the command that must pass), ${fallback}.`;
	return `Runtime notice: writer ${input.label} needs you (${reason}). Re-brief it more prescriptively (the exact change, file and line, and the command that must pass), ${fallback}.`;
}
