import type { SidekickState } from "./sidekick";
import { WRITER_PATCH_APPLY } from "./writer-integration";

/**
 * Builder subagents (docs/subagents.md, decision 2026-10-17): the builder is
 * level 0 and spawns children through one `agent` tool. Placement follows
 * role: a writer works on a fork of the parent's VM, readers share the
 * parent's VM read-only. These are the pure rules; the runtime lives in
 * src/server/services/subagent-*.ts.
 */

export const SUBAGENT_ROLES = [
	"writer",
	"researcher",
	"reviewer",
	"checker",
] as const;
export type SubagentRole = (typeof SUBAGENT_ROLES)[number];
export type ReaderRole = Exclude<SubagentRole, "writer">;

export function isSubagentRole(value: unknown): value is SubagentRole {
	return (SUBAGENT_ROLES as readonly unknown[]).includes(value);
}

export function isReaderRole(role: SubagentRole | null | undefined) {
	return !!role && role !== "writer";
}

/**
 * A reader subagent runs on its parent's VM (stored task_placement 'shared'):
 * it owns neither that machine nor its checkout. So does lead mode fusion's
 * sidekick, a writer in its lead's checkout (src/domain/sidekick.ts), which
 * runs as the builder's user, not the reader's.
 */
export function sharesParentMachine(session: {
	readonly agentRole?: SubagentRole | null;
	readonly taskPlacement: string | null;
}) {
	return (
		isReaderRole(session.agentRole) ||
		(session.agentRole === "writer" && session.taskPlacement === "shared")
	);
}

/** The root chat (the builder) and writer subagents edit their own checkout. */
export function writesOwnCheckout(session: {
	readonly parentSessionId: string | null;
	readonly agentRole?: SubagentRole | null;
}) {
	return !session.parentSessionId || session.agentRole === "writer";
}

/**
 * Where a child runs; not an argument, because it follows from the role.
 * Lead mode fusion's sidekick is the exception: a writer in the lead's own
 * checkout ("shared-writer", src/domain/sidekick.ts).
 */
export type SubagentPlacement = "fork" | "shared-read-only" | "shared-writer";

export function subagentPlacement(role: SubagentRole): SubagentPlacement {
	return role === "writer" ? "fork" : "shared-read-only";
}

/** The deepest level; a child at this level cannot spawn. */
export const MAX_SUBAGENT_LEVEL = 3;
/** Agents running at once anywhere in one tree. */
export const SUBAGENT_TREE_LIVE_LIMIT = 8;
/** The tree's whole token allowance: the existing per-task api_usage_budget. */
export const SUBAGENT_TREE_TOKEN_BUDGET = 5_000_000;
export const SUBAGENT_TITLE_MAX = 80;
export const SUBAGENT_BRIEF_MAX = 12_000;

export type SubagentBudget = {
	readonly steps: number;
	readonly minutes: number;
	readonly tokens: number;
	/** Set by agent_send stop: the step count at which the turn stops. */
	readonly stopAtStep?: number;
	/**
	 * The model `tokens` is counted in (the tree's builder model). The child's
	 * own and its descendants' tokens are weighted by their price relative to
	 * it (budgetTokenWeight in subagent-usage.ts). Absent on older rows: raw
	 * tokens.
	 */
	readonly priceBasis?: string;
	/**
	 * Lead mode fusion: this writer is the lead's persistent sidekick
	 * (src/domain/sidekick.ts). steps and minutes then apply per round,
	 * tokens over its whole life, with a per-round token cap in the state.
	 */
	readonly sidekick?: SidekickState;
	/**
	 * checkerMode=pair (src/domain/checker-pair.ts): a checker that is the
	 * pair's judge (it gets the worker tool), or a reader that is its worker
	 * (it starts no agents).
	 */
	readonly checkerPair?: "judge" | "worker";
	/**
	 * A writer in its parent's own checkout (unattended
	 * helpers=write), not on a fork: it may change only `owns`.
	 */
	readonly sharedWriter?: { readonly owns: readonly string[] };
	/** checkerMode=pair: a worker the judge started on its own model (`model: "strong"`). */
	readonly checkerStrong?: true;
	/**
	 * A side chat (src/domain/side-chat.ts): a conversational agent bound to
	 * this chat. It is not a helper, so the tree, reports and budgets skip it.
	 */
	readonly sideChat?: true;
};

type Level = 1 | 2 | 3;

/**
 * Starting values from the decision; Phase 4 tunes them.
 * `liveChildren` is how many children an agent at that level may run at
 * once (the builder, level 0, gets level 1's four).
 */
export const SUBAGENT_LEVEL_LIMITS: Record<
	Level,
	SubagentBudget & { readonly liveChildren: number }
> = {
	1: { steps: 150, minutes: 30, tokens: 2_000_000, liveChildren: 4 },
	2: { steps: 75, minutes: 15, tokens: 1_000_000, liveChildren: 2 },
	3: { steps: 40, minutes: 8, tokens: 500_000, liveChildren: 0 },
};

/** Live children a parent at `level` may have (the builder is level 0). */
export function liveChildrenAllowed(level: number) {
	if (level <= 0) return SUBAGENT_LEVEL_LIMITS[1].liveChildren;
	return level >= MAX_SUBAGENT_LEVEL
		? 0
		: SUBAGENT_LEVEL_LIMITS[level as Level].liveChildren;
}

/** What is left of a budget; the builder's own steps and minutes are unbounded here. */
export type SubagentRemaining = SubagentBudget;

export type SubagentUsed = {
	readonly steps: number;
	readonly minutes: number;
	/** The node's own tokens plus every descendant's: tree tokens are summed. */
	readonly tokens: number;
};

export function subagentRemaining(
	budget: SubagentBudget,
	used: SubagentUsed,
): SubagentRemaining {
	return {
		steps: Math.max(0, budget.steps - used.steps),
		minutes: Math.max(0, budget.minutes - used.minutes),
		tokens: Math.max(0, budget.tokens - used.tokens),
	};
}

/** The builder's remaining budget: the tree's token allowance, no step or time cap of its own. */
export function builderRemaining(treeTokens: number): SubagentRemaining {
	return {
		steps: Number.POSITIVE_INFINITY,
		minutes: Number.POSITIVE_INFINITY,
		tokens: Math.max(0, SUBAGENT_TREE_TOKEN_BUDGET - treeTokens),
	};
}

/** Below these a child cannot do useful work, so the spawn is refused instead. */
const MINIMUM_BUDGET: SubagentBudget = { steps: 5, minutes: 1, tokens: 50_000 };

/**
 * A new child's budget at `level`: the level's limits, each capped at half of
 * what the parent has left. Null when that leaves too little to be useful.
 */
export function childSubagentBudget(
	level: number,
	parentRemaining: SubagentRemaining,
): SubagentBudget | null {
	if (level < 1 || level > MAX_SUBAGENT_LEVEL) return null;
	const limits = SUBAGENT_LEVEL_LIMITS[level as Level];
	const half = (value: number) =>
		Number.isFinite(value) ? Math.floor(value / 2) : value;
	const budget = {
		steps: Math.min(limits.steps, half(parentRemaining.steps)),
		minutes: Math.min(limits.minutes, half(parentRemaining.minutes)),
		tokens: Math.min(limits.tokens, half(parentRemaining.tokens)),
	};
	return budget.steps >= MINIMUM_BUDGET.steps &&
		budget.minutes >= MINIMUM_BUDGET.minutes &&
		budget.tokens >= MINIMUM_BUDGET.tokens
		? budget
		: null;
}

export type SubagentBudgetState =
	| { readonly state: "ok" }
	| { readonly state: "wrap-up" | "exhausted"; readonly reason: string };

/**
 * At 90% of any dimension the child is told to wrap up; at 100% its turn
 * stops. `wrapUpLeadMinutes` moves the minutes warning earlier (a checker
 * needs time to write its verdict).
 */
export function subagentBudgetState(
	budget: SubagentBudget,
	used: SubagentUsed,
	wrapUpLeadMinutes = 0,
): SubagentBudgetState {
	const dimensions: [string, number, number][] = [
		["steps", used.steps, budget.steps],
		["minutes", used.minutes, budget.minutes],
		["tokens", used.tokens, budget.tokens],
	];
	const describe = ([name, value, limit]: [string, number, number]) =>
		`${name} ${Math.round(value).toLocaleString("en-US")}/${limit.toLocaleString("en-US")}`;
	if (budget.stopAtStep !== undefined) {
		if (used.steps >= budget.stopAtStep)
			return { state: "exhausted", reason: "stopped by the parent" };
		return { state: "wrap-up", reason: "the parent asked you to stop" };
	}
	const exhausted = dimensions.find(([, value, limit]) => value >= limit);
	if (exhausted) return { state: "exhausted", reason: describe(exhausted) };
	const near = dimensions.find(
		([name, value, limit]) =>
			value >=
			(name === "minutes"
				? Math.min(limit * 0.9, limit - wrapUpLeadMinutes)
				: limit * 0.9),
	);
	return near ? { state: "wrap-up", reason: describe(near) } : { state: "ok" };
}

export type SubagentAdmissionInput = {
	/** The spawning agent's level; the builder is 0. */
	readonly parentLevel: number;
	readonly liveChildrenOfParent: number;
	readonly liveInTree: number;
	readonly parentRemaining: SubagentRemaining;
};

export type SubagentAdmission =
	| {
			readonly admitted: true;
			readonly level: number;
			readonly budget: SubagentBudget;
	  }
	| { readonly admitted: false; readonly reason: string };

/**
 * Depth, concurrency and budget, checked before anything is created. A
 * refusal tells the builder to do the work itself.
 */
export function subagentAdmission(
	input: SubagentAdmissionInput,
): SubagentAdmission {
	const level = input.parentLevel + 1;
	const refuse = (reason: string): SubagentAdmission => ({
		admitted: false,
		reason: `${reason} Do this work yourself.`,
	});
	if (level > MAX_SUBAGENT_LEVEL)
		return refuse(`Agents at level ${MAX_SUBAGENT_LEVEL} cannot spawn.`);
	const allowed = liveChildrenAllowed(input.parentLevel);
	if (input.liveChildrenOfParent >= allowed)
		return refuse(
			`You already have ${input.liveChildrenOfParent} running agents (at most ${allowed}).`,
		);
	if (input.liveInTree >= SUBAGENT_TREE_LIVE_LIMIT)
		return refuse(
			`This task already runs ${SUBAGENT_TREE_LIVE_LIMIT} agents, the most one task may run at once.`,
		);
	const budget = childSubagentBudget(level, input.parentRemaining);
	if (!budget) return refuse("Too little budget is left for another agent.");
	return { admitted: true, level, budget };
}

/** Positional ids: 1, 1.2, 1.2.1 (the decision's "id"). */
export function subagentLabelFromTaskLabel(label: string) {
	return label.replace(/^Task\s+/, "");
}

export function subagentLevelFromLabel(label: string) {
	return label.split(".").length;
}

export type SubagentOutcome = "finished" | "failed" | "budget exhausted";

export function subagentReportHeader(input: {
	readonly label: string;
	/** What the chat calls it (helper-names.ts), for the lead's note to the user. */
	readonly name?: string;
	readonly role: SubagentRole;
	readonly outcome: SubagentOutcome;
	readonly steps: number;
	readonly minutes: number;
	readonly tokens: number;
	readonly costUsd?: number | null;
	/** costUsd is a list-price estimate for a plan-billed route. */
	readonly costEstimated?: boolean;
	/** A sidekick's round, e.g. "round 2/6". */
	readonly round?: string;
}) {
	const tokens =
		input.tokens >= 1_000_000
			? `${(input.tokens / 1_000_000).toFixed(1)}M`
			: `${Math.round(input.tokens / 1000)}k`;
	const cost =
		input.costUsd === null || input.costUsd === undefined
			? ""
			: input.costEstimated
				? ` · ~$${input.costUsd.toFixed(2)} list-price est.`
				: ` · $${input.costUsd.toFixed(2)}`;
	return `[agent ${input.label} ${input.role} ${input.outcome}${input.name ? ` · ${input.name}` : ""}${input.round ? ` · ${input.round}` : ""} · ${input.steps} steps · ${Math.max(0, Math.round(input.minutes))}m · ${tokens} tokens${cost}]`;
}

/**
 * A report's header line split from its text: the header's facts after the
 * agent's id and role ("finished · 14 steps · 3m · 120k tokens"), or null
 * when the text has none.
 */
export function splitReportHeader(text: string): {
	readonly meta: string | null;
	readonly body: string;
} {
	const header = /^\[agent \S+ \S+ ([^\]\n]+)\]\s*/.exec(text);
	return header
		? { meta: header[1] ?? null, body: text.slice(header[0].length) }
		: { meta: null, body: text };
}

export type WriterPatch = {
	/** Where the patch lies in the parent's VM. */
	readonly path: string;
	readonly files: readonly string[];
	readonly added: number;
	readonly removed: number;
	readonly sha256: string;
	readonly ref: string;
	readonly base: string;
	/** New files left out of the patch (still on the writer's fork until it is deleted). */
	readonly excluded?: WriterPatchExclusions;
};

export type WriterPatchExclusions = {
	readonly count: number;
	readonly bytes: number;
	/** The first few, by size. */
	readonly paths: readonly string[];
};

/** Directories a writer fills with downloads, caches and scratch, never deliverables. */
const SCRATCH_DIRECTORIES = new Set([
	".cache",
	".mypy_cache",
	".pytest_cache",
	".ruff_cache",
	".tmp",
	".venv",
	".ytimesy",
	"__pycache__",
	"cache",
	"download",
	"downloads",
	"node_modules",
	"scratch",
	"temp",
	"tmp",
	"venv",
]);
/** A new binary at least this large is data the writer fetched, not a change. */
const LARGE_BINARY_BYTES = 100 * 1024;
/** A new file at least this large is not a deliberate edit, text or not. */
const LARGE_FILE_BYTES = 1024 * 1024;

/**
 * Why a file the writer added stays out of its patch, or null to keep it.
 * Ignored files never reach the patch (git add -A skips them); of the rest,
 * scratch, download and cache directories and large binaries are left out
 * unless the writer's brief or messages name the file.
 */
export function writerPatchExclusion(
	file: {
		readonly path: string;
		readonly bytes: number;
		readonly binary: boolean;
	},
	named: string,
): "scratch" | "binary" | "large" | null {
	const name = file.path.split("/").at(-1) ?? file.path;
	if (named.includes(file.path) || (name.length >= 3 && named.includes(name)))
		return null;
	if (
		file.path
			.split("/")
			.slice(0, -1)
			.some((segment) => SCRATCH_DIRECTORIES.has(segment.toLowerCase()))
	)
		return "scratch";
	if (file.binary && file.bytes >= LARGE_BINARY_BYTES) return "binary";
	if (file.bytes >= LARGE_FILE_BYTES) return "large";
	return null;
}

/** A patch this large is more likely to carry stray output than intent. */
export function unusuallyLargePatch(patch: {
	readonly files: readonly unknown[];
	readonly added: number;
	readonly removed: number;
}) {
	return patch.files.length > 30 || patch.added + patch.removed > 2_000;
}

function sizeLabel(bytes: number) {
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${bytes} B`;
}

/** The new files a writer's patch left out, so the parent knows they exist. */
export function excludedFilesNote(excluded: WriterPatchExclusions) {
	return `${excluded.count} new file${excluded.count === 1 ? "" : "s"} (${sizeLabel(excluded.bytes)}) in scratch, download or cache directories or large binaries the brief did not name: ${excluded.paths.join(", ")}${excluded.count > excluded.paths.length ? ", …" : ""}. They stay only on the writer's fork, which is deleted about 30 minutes after this report; name them in a brief if they are deliverables.`;
}

export function writerPatchRef(label: string) {
	return `refs/ytimesy/agents/${label}`;
}

export function writerPatchPath(label: string) {
	return `~/.ytimesy/agents/${label}.patch`;
}

/** Siblings' writers that touched the same files, so the parent hears before it applies. */
export function overlappingWriters(
	files: readonly string[],
	siblings: readonly {
		readonly label: string;
		readonly files: readonly string[];
	}[],
) {
	const own = new Set(files);
	return siblings.flatMap((sibling) => {
		const shared = sibling.files.filter((file) => own.has(file));
		return shared.length ? [{ label: sibling.label, files: shared }] : [];
	});
}

export function writerPatchBlock(
	patch: WriterPatch | null,
	overlaps: ReturnType<typeof overlappingWriters>,
	failure?: string,
) {
	if (!patch)
		return failure
			? `Patch: not transferred (${failure}).`
			: "Patch: no changes.";
	return [
		`Patch: ${patch.path} (${patch.files.length} files, +${patch.added} −${patch.removed}, sha256 ${patch.sha256.slice(0, 16)})`,
		`Ref:   ${patch.ref}   Base: ${patch.base}`,
		...(unusuallyLargePatch(patch)
			? [
					`Warning: this patch is unusually large; check \`git diff --stat ${patch.base} ${patch.ref}\` for downloads or generated output before applying.`,
				]
			: []),
		...(patch.excluded?.count
			? [`Left out: ${excludedFilesNote(patch.excluded)}`]
			: []),
		...(overlaps.length
			? [
					`Overlaps with: ${overlaps.map((overlap) => `agent ${overlap.label} (${overlap.files.slice(0, 4).join(", ")}${overlap.files.length > 4 ? ", …" : ""})`).join("; ")}`,
				]
			: []),
		`Review with \`git diff ${patch.base} ${patch.ref}\`; apply with \`${WRITER_PATCH_APPLY(patch.path)}\` (or merge the ref).`,
	].join("\n");
}

/** The builder's delegation tools (always in the tool list when offered). */
export const AGENT_TOOL = "agent";
export const AGENT_SEND_TOOL = "agent_send";

/** A writer's forked VM, as recorded on its session (agent_fork). */
export type SubagentFork = {
	readonly vmId: string;
	readonly sourceVmId: string;
	/** Milliseconds from snapshot start to the fork VM running. */
	readonly forkMs?: number;
	readonly bootedAt: string;
	/** The fork's first commit: the parent's working tree at fork time. */
	readonly base?: string;
	/** The parent's HEAD when the fork was taken (the bundle's boundary). */
	readonly parentHead?: string;
	readonly patch?: WriterPatch | null;
	readonly reportedAt?: string;
	readonly deletedAt?: string;
};
