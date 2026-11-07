import {
	isModelRole,
	MODEL_ROLES,
	parseRoleModel,
	type RoleModels,
	roleModelsFlags,
	roleModelsFromUnknown,
} from "./role-models";

/**
 * Harness variants. DEFAULT_HARNESS_VARIANT is the product's behaviour for
 * everyone; in development, some users (dev_eval_user) may pick other values
 * per run to compare harness behaviour on one deployment. Production only
 * ever uses the default.
 */
export const HARNESS_VARIANT_VALUES = {
	/**
	 * How recalled memory (MEMORY.md and read-hook lines) is presented:
	 * rules = binding project rules from earlier chats (the default);
	 * notes = neutral data that may be outdated.
	 */
	memoryWording: ["notes", "rules"],
	/**
	 * Who writes cross-chat memory during a chat (dreaming always runs):
	 * observer = only the save hook (full mode) and dreaming, and the builder
	 * writes ~/memory only when the user explicitly asks it to remember
	 * something (the default); both = the builder saves proactively and the
	 * save hook runs after every turn; agent = only the builder, no save hook.
	 */
	memoryWriter: ["both", "agent", "observer"],
	/**
	 * The builder's tool surface (builderToolSurface in
	 * src/server/services/builder-shell-surface.ts): lean = our core four
	 * tools (read, write, edit, bash) for every model (the default,
	 * docs/decisions/2026-10-17-lean-tool-surface.md); current = the
	 * earlier shell surface; lean-native = each model family's own
	 * tool shapes.
	 */
	toolSurface: ["current", "lean-native", "lean"],
	/**
	 * Which requests share a provider prompt-cache routing key (the ChatGPT
	 * plan route's session-id and prompt_cache_key, an API route's cache
	 * key): chat = one key per chat (the
	 * default); account = one key for all of the user's chats on that
	 * connection, so a new chat's first request can reuse the instructions and
	 * tools an earlier chat already cached.
	 */
	promptCacheScope: ["chat", "account"],
	/**
	 * Code mode on a lean surface: on adds run_code, a JavaScript program
	 * that calls the other tools (several reads, searches and commands in one
	 * model call; src/server/services/code-mode-tool.ts); primary makes
	 * run_code the main way to work (its description and instructions teach
	 * batching) and a large MCP setup's search and call tools callable only
	 * from inside run_code (searchTools(query) for their declarations);
	 * agent, agent_send and ask_user stay in the tool list. off
	 * offers the surface unchanged (the default).
	 */
	codeMode: ["off", "on", "primary"],
	/**
	 * Builder subagents (docs/subagents.md): on gives the builder the agent
	 * and agent_send tools (ordinary tools in the tool list, in every code
	 * mode), the orchestration prompt block, per-level
	 * budgets and the subagent tree; off offers the surface unchanged (the
	 * default) until it is shown to pay off. force is on plus a prompt
	 * line that requires the root builder to delegate at least once (the
	 * shape is its choice): which applies delegation even when the
	 * model would not choose it.
	 */
	subagents: ["off", "on", "force"],
	/**
	 * Pull request evidence: on makes the harness capture screenshots, a
	 * short recording or CLI output from the pushed commit when a turn's
	 * draft handoff has visible changes (or a `ytimesy-evidence` plan), store
	 * them and keep an Evidence section in the PR description current
	 * (src/server/services/pr-evidence.ts); on is the default, off changes
	 * nothing. The agent's own ytimesy-browser captures are evidence either way.
	 */
	prEvidence: ["off", "on"],
	/**
	 * Behavioural guidance on a lean surface (src/domain/instruction-profiles.ts,
	 * docs/instruction-tuning.md): default = the model family's chosen profile
	 * (INSTRUCTION_PROFILE_BY_FAMILY, baseline for every family today);
	 * baseline = the v13-lean guidance unchanged; verify-hard, plan-first and
	 * persist each add one paragraph; concise replaces the guidance with a
	 * short version.
	 */
	instructions: [
		"baseline",
		"verify-hard",
		"plan-first",
		"persist",
		"concise",
		"default",
	],
	/**
	 * The attempt loop (src/server/services/attempt-loop.ts, decision
	 * 2026-10-17 Phase 2): 3 = when the root builder finishes, an independent
	 * checker subagent tests the delivered result against the user's request;
	 * a failed or unsure attempt is kept as a candidate, the working tree is
	 * reset and the builder tries a different approach, up to three attempts
	 * within a time and token budget, and the best candidate is kept. 1 = one
	 * attempt, unchanged behaviour (the default).
	 */
	attempts: ["1", "3"],
	/**
	 * The review loop (src/server/services/review-loop.ts, decision
	 * 2026-10-18 "A"): on = when the root builder finishes a turn that
	 * changed files (and ran long enough or delivered something runnable),
	 * an independent checker subagent reviews the work against the user's
	 * request; concrete findings go back to the same run as one runtime
	 * notice and the builder verifies and fixes them, up to two rounds,
	 * within the time left. off = unchanged behaviour (the default). Not
	 * combined with attempts=3 (the attempt loop wins).
	 */
	review: ["off", "on"],
	/**
	 * The checker's shape (src/domain/checker-pair.ts): single = one checker
	 * reads, tests and judges (the default); pair = a judge on
	 * roleModels.checker plans the check and writes the verdict, and a
	 * cheaper read-only worker on roleModels.checkerWorker (codex:gpt-6-luna
	 * when unset) does the reading, test writing and running it briefs. Each
	 * review round is still a full independent check. blind: the checker
	 * first works out what the request requires from the checkout as it was
	 * before the work (no deliverable in view) and writes its tests there,
	 * then runs them against the deliverable (src/domain/checker-brief.ts).
	 */
	checkerMode: ["single", "pair", "blind"],
	/**
	 * Lead mode (src/domain/sidekick.ts, fusion makes
	 * the root builder a lead that plans, briefs, reviews and answers the
	 * user, and makes its first writer a persistent sidekick (cheaper model
	 * via roleModels.writer) that keeps its context and fork across rounds of
	 * briefs and feedback, its fork synced with the lead's checkout before
	 * each round. Implies the agent tools (as subagents=on). off = unchanged
	 * behaviour (the default).
	 */
	lead: ["off", "fusion"],
	/**
	 * The fusion lead's own tools (lead=fusion only; src/server/services/
	 * thin-lead-tools.ts): thin = it plans, briefs and reviews: agent,
	 * agent_send, a capped read and a bounded read-only inspection command
	 * (git status/diff/log, ls, head and the like), no edits, no general
	 * shell, no run_code (the default); full = the builder's whole surface
	 * beside its writer, as before (kept for comparison).
	 */
	leadTools: ["thin", "full"],
	/**
	 * The fusion lead's reasoning effort (lead=fusion only): a ceiling on
	 * the turn's effort for the lead's own model calls; its writer and the
	 * checker keep their own. high (the default): the lead plans and reviews,
	 * it does not solve, and at max its reasoning was most of its output.
	 * inherit = the turn's effort unchanged.
	 */
	leadEffort: ["high", "inherit", "low", "medium", "xhigh", "max"],
	/**
	 * Rigor (src/domain/rigor.ts): on adds the builder's rigor block
	 * (ambiguity resolved by convention, else the strictest reading, with a
	 * margin on numeric thresholds; no finishing with time left and something
	 * unverified; one run of the deliverable as an outside user would run it),
	 * the matching checks to every checker brief, and makes the review loop
	 * send back a final answer that admits unverified work while over half
	 * the time is left. off = unchanged behaviour (the default).
	 */
	rigor: ["off", "on"],
	/**
	 * The most characters one tool result shows the model (the builder's
	 * surface tools, src/server/services/tool-output-cap.ts): a longer one
	 * keeps its head and tail, and the note between them says where the rest
	 * is. off = the surface's own limits only (the default).
	 */
	outputCap: ["off", "10000", "16000"],
	/**
	 * Grind budget (unattended runs only): on
	 * sends a builder that finishes early, with most of its time left, back
	 * at most twice to try to break its own result before it may finish.
	 * off = the builder stops when it says it is done (the default).
	 */
	grind: ["off", "on"],
	/**
	 * The reasoning sandwich (unattended runs only): on keeps the turn's effort for the root builder's
	 * first two model requests (planning) and for continuation rounds the
	 * harness sends (grind), and holds every other request at high. A turn
	 * effort of high or lower is unchanged. off = the turn's effort for every
	 * request (the default).
	 */
	effortMix: ["off", "on"],
	/**
	 * Environment snapshot (unattended runs only):
	 * on runs one fixed read-only probe in the sandbox (OS, resources, file
	 * tree, project files, tools, network, processes) before the builder's
	 * first request and puts its output above the request. off = the request
	 * alone (the default).
	 */
	envSnapshot: ["off", "on"],
	/**
	 * Requirement ledger (unattended runs only): on gives the root builder a requirements tool
	 * and a first-message note to record the request's requirements (quote,
	 * readings, one check command each) before building; when it finishes,
	 * the harness runs every check and sends a failure (or a missing ledger)
	 * back, at most twice. off = no ledger (the default).
	 */
	ledger: ["off", "on"],
	/**
	 * Goal mode (unattended runs only; src/domain/goal.ts): on makes the
	 * request the run's goal, gives the root builder the goal tool, and sends
	 * it back with an audit notice while the goal is active, until it marks
	 * the goal complete with evidence or blocked, or a deterministic stop
	 * (deadline, no progress, continuation cap). Supersedes grind. off = the
	 * builder stops when it says it is done (the default).
	 */
	goal: ["off", "on"],
	/**
	 * Plan tool (src/server/services/plan-tool.ts): on gives the root builder
	 * update_plan, a short step list (each step pending, in_progress or
	 * completed) the harness keeps and records. off = no
	 * plan tool (the default).
	 */
	plan: ["off", "on"],
	/**
	 * Read-only helpers (unattended runs only):
	 * on gives the root builder agent / agent_wait / agent_send for
	 * researcher and reviewer subagents, each on its own read-only copy of
	 * the checkout, on the builder's model. The builder stays the only
	 * writer. write = on plus writer helpers: each works in the builder's
	 * own checkout (no copy) and may change only the paths its brief gives
	 * it (`owns`). write-tree = write with the product's writer mechanic:
	 * each writer works on its own git worktree of the builder's checkout
	 * (uncommitted work included) and returns a patch and git ref the builder
	 * reviews and applies with `git apply -3`, as a product writer on a VM
	 * fork. off = no helpers (the default).
	 */
	helpers: ["off", "on", "write", "write-tree"],
	/**
	 * Web fetch (src/server/services/web-fetch-tool.ts): on gives every agent
	 * web_fetch, one public http(s) page as text, fetched from the harness
	 * side on any route (not a provider-hosted tool). off = no web_fetch (the
	 * default).
	 */
	fetch: ["off", "on"],
	/**
	 * The unattended builder's system prompt: full = the product's lean
	 * prompt (the default); minimal = identity, the tool and run_code
	 * guidance, helpers when on, and a brief final answer only.
	 */
	prompt: ["full", "minimal"],
	/**
	 * Web search on unattended runs: hosted = the provider's search tool in
	 * every request (the default; it adds hidden input tokens to each
	 * request); function = a plain
	 * web_search function tool whose call makes one separate low-effort
	 * request with the hosted tool, so that overhead is paid only per search.
	 */
	search: ["hosted", "function"],
	/**
	 * The unattended builder's check-in-proportion rule (stop once one run of
	 * the deliverable confirms the result): full = without it (the default
	 * since 2026-10-27: it stopped hard, target-driven tasks after the first
	 * passing check); proportion = with it (about 10% cheaper on easy tasks).
	 */
	checks: ["full", "proportion"],
} as const;

type Values = typeof HARNESS_VARIANT_VALUES;
export type HarnessVariant = {
	readonly [Key in keyof Values]: Values[Key][number];
} & {
	/**
	 * A model per subagent role (src/domain/role-models.ts): writer,
	 * researcher, reviewer, checker, judge, checkerWorker, ... Empty (the default): every child
	 * runs on its parent's model. Flags: `roleModels.<role>=<model>[@<effort>]`.
	 */
	readonly roleModels: RoleModels;
};
export type MemoryWording = HarnessVariant["memoryWording"];
export type MemoryWriter = HarnessVariant["memoryWriter"];
export type HarnessToolSurfaceId = HarnessVariant["toolSurface"];
export type PromptCacheScope = HarnessVariant["promptCacheScope"];
export type CodeMode = HarnessVariant["codeMode"];
export type SubagentsMode = HarnessVariant["subagents"];
export type PrEvidence = HarnessVariant["prEvidence"];
export type InstructionVariant = HarnessVariant["instructions"];
export type AttemptsMode = HarnessVariant["attempts"];
export type ReviewMode = HarnessVariant["review"];
export type CheckerMode = HarnessVariant["checkerMode"];
export type LeadMode = HarnessVariant["lead"];
export type LeadTools = HarnessVariant["leadTools"];
export type LeadEffort = HarnessVariant["leadEffort"];
export type RigorMode = HarnessVariant["rigor"];
export type OutputCap = HarnessVariant["outputCap"];

export const DEFAULT_HARNESS_VARIANT: HarnessVariant = {
	memoryWording: "rules",
	memoryWriter: "observer",
	toolSurface: "lean",
	promptCacheScope: "chat",
	codeMode: "off",
	subagents: "off",
	prEvidence: "on",
	instructions: "default",
	attempts: "1",
	review: "off",
	checkerMode: "single",
	lead: "off",
	leadTools: "thin",
	leadEffort: "high",
	rigor: "off",
	outputCap: "off",
	grind: "off",
	effortMix: "off",
	envSnapshot: "off",
	ledger: "off",
	goal: "off",
	plan: "off",
	helpers: "off",
	fetch: "off",
	prompt: "full",
	search: "hosted",
	checks: "full",
	roleModels: {},
};

/**
 * What real users get: builder subagents on, and
 * code mode (run_code beside the normal tools), web_fetch and the root
 * builder's update_plan (the chat's checklist). Unattended runs keep
 * DEFAULT_HARNESS_VARIANT as their baseline.
 */
export const PRODUCT_HARNESS_VARIANT: HarnessVariant = {
	...DEFAULT_HARNESS_VARIANT,
	subagents: "on",
	codeMode: "on",
	fetch: "on",
	plan: "on",
};

/** The outputCap variant's limit in characters; undefined when off. */
export function outputCapCharacters(cap: OutputCap) {
	return cap === "off" ? undefined : Number(cap);
}

/** Effort levels from least to most; a route's other names (none, minimal) rank below low. */
const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"];

/**
 * The fusion lead's effort: the turn's effort held at or below leadEffort
 * (inherit, or an unknown or lower turn effort, keeps the turn's).
 */
export function leadReasoningEffort<Effort extends string>(
	turn: Effort | undefined,
	cap: LeadEffort,
): Effort | undefined {
	if (cap === "inherit" || turn === undefined) return turn;
	const rank = EFFORT_ORDER.indexOf(turn);
	return rank > EFFORT_ORDER.indexOf(cap) ? (cap as Effort) : turn;
}

/**
 * The scope a turn's prompt-cache key is derived from (hashed with the user
 * and connection, never sent as is): the chat, or one fixed scope per
 * account.
 */
export function promptCacheScopeId(scope: PromptCacheScope, chatId: string) {
	return scope === "account" ? "account" : chatId;
}

function isKey(key: string): key is keyof Values {
	return Object.hasOwn(HARNESS_VARIANT_VALUES, key);
}

function validValue(key: keyof Values, value: unknown) {
	return (HARNESS_VARIANT_VALUES[key] as readonly unknown[]).includes(value);
}

/**
 * A stored variant: unknown keys and values fall back to the default, so a
 * row written by a newer script never breaks a turn.
 */
export function harnessVariantFromUnknown(value: unknown): HarnessVariant {
	const variant: Record<string, unknown> = { ...DEFAULT_HARNESS_VARIANT };
	if (value && typeof value === "object" && !Array.isArray(value))
		for (const [key, entry] of Object.entries(value))
			if (key === "roleModels")
				variant.roleModels = roleModelsFromUnknown(entry);
			else if (isKey(key) && validValue(key, entry)) variant[key] = entry;
	return variant as HarnessVariant;
}

/** `key=value` flags (e.g. `memoryWording=rules`); unknown keys or values throw. */
export function harnessVariantFromFlags(
	flags: readonly string[] = [],
): HarnessVariant {
	const variant: Record<string, unknown> = { ...DEFAULT_HARNESS_VARIANT };
	for (const flag of flags)
		for (const pair of flag.split(",")) {
			const [key, value, ...rest] = pair.split("=").map((part) => part.trim());
			const role = /^roleModels\.(.+)$/.exec(key ?? "")?.[1];
			if (role !== undefined && value !== undefined && !rest.length) {
				if (!isModelRole(role))
					throw new Error(
						`--variant roleModels.<role> takes a role in ${MODEL_ROLES.join(", ")}; got "${role}".`,
					);
				variant.roleModels = {
					...(variant.roleModels as RoleModels),
					[role]: parseRoleModel(value),
				};
				continue;
			}
			if (!key || value === undefined || rest.length || !isKey(key))
				throw new Error(
					`--variant expects key=value with key in ${Object.keys(HARNESS_VARIANT_VALUES).join(", ")}; got "${pair}".`,
				);
			if (!validValue(key, value))
				throw new Error(
					`--variant ${key} accepts ${HARNESS_VARIANT_VALUES[key].join(", ")}; got "${value}".`,
				);
			variant[key] = value;
		}
	return variant as HarnessVariant;
}

/** Only the keys that differ from the default, for labels and stored rows. */
export function harnessVariantChanges(
	variant: HarnessVariant,
): Partial<HarnessVariant> {
	return Object.fromEntries(
		Object.entries(variant).filter(([key, value]) =>
			key === "roleModels"
				? Object.keys(value ?? {}).length > 0
				: DEFAULT_HARNESS_VARIANT[key as keyof HarnessVariant] !== value,
		),
	) as Partial<HarnessVariant>;
}

export function harnessVariantLabel(variant: HarnessVariant) {
	const changes = Object.entries(harnessVariantChanges(variant)).flatMap(
		([key, value]) =>
			key === "roleModels"
				? roleModelsFlags(value as RoleModels)
				: [`${key}=${value}`],
	);
	return changes.length ? changes.join(",") : "default";
}
