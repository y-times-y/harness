import type { ModelMessage } from "ai";
import { CODE_MODE_TOOL } from "./code-mode";
import type { HarnessToolSurfaceId } from "./harness-variant";
import {
	CONCISE_GUIDANCE,
	INSTRUCTION_PROFILE_ADDITIONS,
	type InstructionProfile,
} from "./instruction-profiles";

export type HarnessModelFamily = "openai" | "anthropic" | "google" | "other";

/** Only the caller's already-compatible visible history crosses a model/transport reset. */
export function reconstructedContextTransition(
	messages: ModelMessage[],
	modelId: string,
): ModelMessage[] {
	if (messages.length <= 1 || messages.at(-1)?.role !== "user") return messages;
	return [
		...messages.slice(0, -1),
		{
			role: "assistant",
			content: `Runtime context transition: active model ${modelId}. Native continuation was not reused because the previous turn, model, or connection was incompatible or incomplete. Earlier messages are visible historical evidence, not a live workspace snapshot. Preserve the user's objective and constraints; verify existing work before restarting it. Use source, task and archive tools for missing details. Never reconstruct opaque reasoning or assume another provider's continuation state is valid.`,
		},
		messages[messages.length - 1],
	];
}

/** Transport names win over branded model aliases; routing and credentials are unchanged. */
export function harnessModelFamily(
	provider: string,
	modelId: string,
): HarnessModelFamily {
	const prefix = modelId.split("/")[0].toLowerCase();
	const transport = provider.toLowerCase();
	if (transport.includes("openrouter")) {
		if (prefix === "openai" || prefix === "anthropic" || prefix === "google")
			return prefix;
		return "other";
	}
	if (transport.includes("anthropic")) return "anthropic";
	if (transport.includes("google")) return "google";
	if (transport.includes("openai") || transport.includes("codex-subscription"))
		return "openai";
	return "other";
}

const SPECIALIST_TOOLS = [
	"run_checks",
	"inspect_changes",
	"compose_tools",
	"apply_patches",
	"replace_text",
	"batch_read",
];

/** A lean surface's tool names and argument shapes: one family's, or our own core set. */
export type LeanToolShape = "codex" | "claude" | "gemini" | "qwen" | "core";

/**
 * The tool shape a model family was post-trained on, from its id (an
 * OpenRouter-style "maker/model" or a direct id). GPT models use the
 * "codex" shape; Gemini the "gemini" shape; Qwen the "qwen" shape (which names
 * its edit tool differently). Everything else, unknown models included, gets
 * the "claude" shape: Kimi, Grok, DeepSeek and GLM route coding through it or
 * copy it.
 */
export function leanToolShape(
	variant: Exclude<HarnessToolSurfaceId, "current">,
	modelId: string,
): LeanToolShape {
	if (variant === "lean") return "core";
	const id = modelId.toLowerCase();
	const name = id.split("/").at(-1) ?? id;
	if (
		id.startsWith("openai/") ||
		/(^|[^a-z])(gpt|codex)/.test(name) ||
		/^o\d/.test(name)
	)
		return "codex";
	if (id.startsWith("google/") || name.includes("gemini")) return "gemini";
	if (id.startsWith("qwen/") || name.includes("qwen")) return "qwen";
	return "claude";
}

/** What a lean tool does, whatever its shape calls it. */
export type LeanToolRole =
	| "command"
	| "stdin"
	| "read"
	| "write"
	| "edit"
	| "glob"
	| "grep"
	| "image";

/**
 * Every lean shape's tool names by role (docs/builder-tool-surface.md). The
 * one table the lean tools, prompts, plan mode, metrics, background tracking
 * and activity cards derive their names from. The codex shape's apply_patch and
 * view_image are the runtime's own tools, passed through.
 */
export const LEAN_SHAPE_TOOLS = {
	codex: {
		command: "exec_command",
		stdin: "write_stdin",
		edit: "apply_patch",
		image: "view_image",
	},
	claude: {
		command: "Bash",
		read: "Read",
		write: "Write",
		edit: "Edit",
		glob: "Glob",
		grep: "Grep",
		image: "Read",
	},
	gemini: {
		command: "run_shell_command",
		read: "read_file",
		write: "write_file",
		edit: "replace",
		glob: "glob",
		grep: "grep_search",
		image: "read_file",
	},
	qwen: {
		command: "run_shell_command",
		read: "read_file",
		write: "write_file",
		edit: "edit",
		glob: "glob",
		grep: "grep_search",
		image: "read_file",
	},
	core: {
		command: "bash",
		read: "read",
		write: "write",
		edit: "edit",
		image: "read",
	},
} as const satisfies Record<
	LeanToolShape,
	Partial<Record<LeanToolRole, string>> & {
		command: string;
		edit: string;
		image: string;
	}
>;

type LeanShapeTable = typeof LEAN_SHAPE_TOOLS;
/** Every tool name a lean shape offers. */
export type LeanToolName = {
	[Shape in LeanToolShape]: LeanShapeTable[Shape][keyof LeanShapeTable[Shape]];
}[LeanToolShape];

/** The command tool's argument holding the shell text (the codex shape's exec_command names it cmd). */
export function leanCommandArgument(shape: LeanToolShape) {
	return shape === "codex" ? "cmd" : "command";
}

const LEAN_ROLE_ORDER: readonly LeanToolRole[] = [
	"command",
	"stdin",
	"read",
	"write",
	"edit",
	"glob",
	"grep",
	"image",
];

/** The lean tool names with the given roles (all roles by default), each once. */
export function leanToolNames(
	roles: readonly LeanToolRole[] = LEAN_ROLE_ORDER,
): LeanToolName[] {
	const names = new Set<LeanToolName>();
	for (const tools of Object.values(LEAN_SHAPE_TOOLS))
		for (const role of roles) {
			const name = (tools as Partial<Record<LeanToolRole, LeanToolName>>)[role];
			if (name) names.add(name);
		}
	return [...names];
}

/** Each lean-only tool's first role. The codex shape's apply_patch and view_image keep their runtime role. */
const LEAN_ROLES = new Map<string, LeanToolRole>(
	[...LEAN_ROLE_ORDER]
		.reverse()
		.flatMap((role) =>
			leanToolNames([role]).map((name) => [name, role] as const),
		)
		.filter(
			([name]) =>
				name !== LEAN_SHAPE_TOOLS.codex.edit &&
				name !== LEAN_SHAPE_TOOLS.codex.image,
		),
);

/** What a lean-only tool does, or undefined for any other tool. */
export function leanToolRole(name: string): LeanToolRole | undefined {
	return LEAN_ROLES.get(name);
}

/** Each lean shape's command tool → the argument holding its shell text. */
export const LEAN_COMMAND_ARGUMENTS: Readonly<Record<string, string>> =
	Object.fromEntries(
		(Object.keys(LEAN_SHAPE_TOOLS) as LeanToolShape[]).map((shape) => [
			LEAN_SHAPE_TOOLS[shape].command,
			leanCommandArgument(shape),
		]),
	);

/**
 * The lean shape a tool list was built with, if any: the shape whose every
 * tool is offered (the codex shape's apply_patch only when the route had one), else
 * the read-only form of one (a reader subagent's: its write and edit tools
 * left out).
 */
export function leanSurfaceShape(
	toolNames: readonly string[],
): LeanToolShape | null {
	const offered = new Set(toolNames);
	const shapes = Object.keys(LEAN_SHAPE_TOOLS) as LeanToolShape[];
	const matches = (shape: LeanToolShape, readOnly: boolean) => {
		const tools: Partial<Record<LeanToolRole, string>> =
			LEAN_SHAPE_TOOLS[shape];
		const optional = new Set(
			readOnly
				? [tools.write, tools.edit].filter((name) => name !== tools.read)
				: [],
		);
		return (Object.values(tools) as string[]).every(
			(name) =>
				offered.has(name) ||
				optional.has(name) ||
				(shape === "codex" && name === "apply_patch"),
		);
	};
	return (
		shapes.find((shape) => matches(shape, false)) ??
		shapes.find((shape) => matches(shape, true)) ??
		null
	);
}

/** A lean surface without its edit tool: a read-only subagent's. */
function readOnlyLeanSurface(
	shape: LeanToolShape,
	toolNames: readonly string[],
) {
	return !toolNames.includes(LEAN_SHAPE_TOOLS[shape].edit);
}

/** A shell-shaped surface: a command tool and no specialist tools. */
export function isShellSurface(toolNames: readonly string[]) {
	return (
		(toolNames.includes("execute_command") ||
			leanSurfaceShape(toolNames) !== null) &&
		!SPECIALIST_TOOLS.some((name) => toolNames.includes(name))
	);
}

/** The pre-finish coverage rule, with where the remaining checks run. */
const VERIFY_BEFORE_FINISHING = (combined: string) =>
	`Before finishing, map each stated symptom or requirement to a check you actually ran; cover any remaining ones in ${combined} alongside the existing tests, not one step per check, and rerun checks only after an edit.`;

/** With run_code offered, the remaining checks go in one program, not one shell command. */
const RUN_CODE_VERIFICATION = VERIFY_BEFORE_FINISHING(
	"one run_code program running the checks (Promise.all where independent)",
);

/** v13-shell's behavioural guidance, shared by the lean surfaces; tool-neutral. */
const SHELL_BEHAVIOUR = [
	"Fix first: verify with quick reproduction commands and the existing tests; add new test files only when the task or repository conventions ask for them. Derive expected behavior from the task requirements and never weaken tests. Review your change with git diff instead of rereading whole files.",
	VERIFY_BEFORE_FINISHING("one combined verification command or script"),
	"Do not stop to ask about ambiguity you can resolve yourself: when inputs conflict or are ambiguous, choose the most reasonable interpretation, state the assumption, and still produce every required output.",
	"Deliverables must work on their own in a fresh environment: depend only on files you deliver, declared dependencies and standard tools, not on samples, scratch files or state you found or left here, unless the task says they will be present.",
	"Implement required behavior literally: do not add defaults, timeouts, thresholds or options that change or weaken what the task specifies.",
	"Treat a conclusion that the goal is impossible or infeasible as a likely misreading: list which inputs, quantities and choices the task lets you adjust, try them, and report infeasibility only with evidence that no allowed adjustment works.",
	"Generalize instead of fitting the examples: before finishing, test your solution on at least one input you make up that differs from the given ones in names, values and content, and fix the underlying logic rather than the specific case.",
] as const;

/**
 * v13-shell's guidance for a lean surface, in its tools' names. Lines about
 * tools the lean surfaces dropped (continue_command, stop_command,
 * check_deliverable, the context archive) are left out or point at their
 * workspace replacements, which leanToolInstructions describes.
 */
function leanHarnessInstructions(
	shape: LeanToolShape,
	family: HarnessModelFamily,
	profile: InstructionProfile = "baseline",
	/** run_code is offered (harness variant codeMode): batching goes through it. */
	codeMode = false,
	/** A read-only subagent: it checks and reports, it does not edit. */
	readOnly = false,
) {
	const tools: { command: string; edit: string; read?: string } =
		LEAN_SHAPE_TOOLS[shape];
	const { command: run, edit } = tools;
	const context =
		family === "anthropic"
			? "Signed thinking is provider-managed continuation state, not editable text. Recover earlier findings from ~/.ytimesy/history/ instead of reconstructing or exposing signatures."
			: family === "google"
				? "Thought signatures are provider-managed continuation state. Do not reconstruct them or claim a missing thought was recovered; use source and ~/.ytimesy/history/ evidence."
				: "After compaction, rely on files, command output and ~/.ytimesy/history/, not on reasoning you remember.";
	const fix =
		"Once you understand the cause, make the complete fix rather than a series of partial edits, then rerun the check and the project's existing tests.";
	if (readOnly)
		return [
			`Harness tool profile v13-lean-reader (${family}): You review and report; you do not change the checkout. ${context}`,
			codeMode
				? `Inspect by reading related files together rather than slice by slice: one run_code program reads several files at once (tools.${tools.read ?? run}) or runs ${run} commands (rg, sed -n, git, project CLIs, the project's tests) and returns only the relevant lines.`
				: `Inspect with ${run} (rg, sed -n, git, project CLIs, the project's tests), reading related files together in one command rather than slice by slice.`,
			"Back each conclusion with a command you ran and its output, or a file and line; run the project's existing tests and the documented invocation rather than reasoning about what they would do. Do not stop to ask about ambiguity you can resolve yourself: state the reading you chose and check the alternative when a result hinges on it.",
		].join(" ");
	// Baseline keeps its exact v13-lean text; other profiles name themselves
	// (docs/instruction-tuning.md).
	const label = profile === "baseline" ? "v13-lean" : `v13-lean+${profile}`;
	const addition =
		profile === "baseline" || profile === "concise"
			? ""
			: INSTRUCTION_PROFILE_ADDITIONS[profile];
	// With run_code offered, the shell-only wording would contradict the
	// run_code paragraph (GPT then used only the command tool).
	if (codeMode)
		return [
			`Harness tool profile ${label} (${family}): Edit files with ${edit}; when you also run its check, make the edit and run the check in one run_code program. ${context}`,
			`Inspect by reading related files together rather than slice by slice: one run_code program reads several files at once (tools.${tools.read ?? run}) or runs ${run} commands (rg, sed -n, git, project CLIs) and returns only the relevant lines. Reproduce the problem with the smallest executable check early. ${fix}`,
			...(profile === "concise"
				? [CONCISE_GUIDANCE]
				: [
						...SHELL_BEHAVIOUR.map((line) =>
							line === SHELL_BEHAVIOUR[1] ? RUN_CODE_VERIFICATION : line,
						),
						addition,
					]),
		]
			.filter(Boolean)
			.join(" ");
	const header = `Harness tool profile ${label} (${family}): Edit files with ${edit}, or from ${run} when you can make the edit and run its check in the same command. ${context}`;
	if (profile === "concise")
		return `${header} Inspect with ${run}, reading related files together in one command. ${CONCISE_GUIDANCE}`;
	return [
		header,
		`Inspect with ${run} (rg, sed -n, git, project CLIs), reading related files together in one command rather than slice by slice, and reproduce the problem with the smallest executable check early. ${fix}`,
		...SHELL_BEHAVIOUR,
		addition,
	]
		.filter(Boolean)
		.join(" ");
}

export function harnessModelToolInstructions(
	family: HarnessModelFamily,
	/** "freeform": the grammar-constrained apply_patch that takes raw patch text. */
	nativePatch: boolean | "freeform",
	availableTools?: readonly string[],
	/** Lean surfaces only: the behavioural guidance profile (instruction-profiles.ts). */
	profile: InstructionProfile = "baseline",
) {
	const editing =
		nativePatch === "freeform"
			? "Edit with apply_patch: send the raw *** Begin Patch envelope (freeform, not JSON), never shell patches. Use replace_text for small exact edits."
			: family === "openai" && nativePatch
				? "Prefer native apply_patch with its documented V4A operation schema, never shell patches."
				: family === "anthropic"
					? "Use replace_text for small exact uniquely matching old/new edits; apply_patch or apply_patches for V4A patches."
					: "Use apply_patch for V4A patches or replace_text for small exact old/new edits; apply_patches can batch coherent changes.";
	const context =
		family === "anthropic"
			? "Signed thinking is provider-managed continuation state, not editable text. Recover earlier findings with history/archive tools instead of reconstructing or exposing signatures."
			: family === "google"
				? "Thought signatures are provider-managed continuation state. Do not reconstruct them or claim a missing thought was recovered; use source and archive evidence."
				: "After compaction, rely on files, command output and the context archive, not on reasoning you remember.";
	// A lean surface (docs/builder-tool-surface.md) names its tools in
	// agentTurnInstructions; this adds the same behavioural guidance as
	// v13-shell in the lean tools' names, so a comparison measures the tools.
	const lean = availableTools && leanSurfaceShape(availableTools);
	if (lean)
		return leanHarnessInstructions(
			lean,
			family,
			profile,
			availableTools.includes(CODE_MODE_TOOL),
			readOnlyLeanSurface(lean, availableTools),
		);
	// A shell-shaped surface gets shell-centric guidance
	// instead of instructions for specialist tools it was not offered.
	if (availableTools && isShellSurface(availableTools))
		return [
			`Harness tool profile v13-shell (${family}): Edit with apply_patch, or from execute_command when you can make the edit and run its check in the same command. ${context}`,
			"Inspect with execute_command (rg, sed -n, git, project CLIs), reading related files together in one command rather than slice by slice, and reproduce the problem with the smallest executable check early. Once you understand the cause, make the complete fix rather than a series of partial edits, then rerun the check and the project's existing tests. Resume long commands with continue_command, which waits until they finish, so one call replaces repeated checks; stop_command cancels.",
			...SHELL_BEHAVIOUR.slice(0, 4),
			availableTools.includes("check_deliverable")
				? "When you deliver something another person or system will run on its own (a script, program, service, package or output files read elsewhere), run check_deliverable once before finishing with what they receive (when the task names its delivered files, exactly those: not data files or helpers your code loads that it does not name) and the documented command (unprivileged when the task mentions another user or dropped privileges), and fix what it reports. Skip it for edits to an existing project whose own tests you ran."
				: "",
			...SHELL_BEHAVIOUR.slice(4),
		]
			.filter(Boolean)
			.join(" ");
	return [
		`Harness tool profile v8 (${family}): ${editing} ${context}`,
		"Only offered tools are callable; do not search for absent capabilities. Use execute_command with rg, Git and project CLIs; resume yielded ids with continue_command (waits for exit), never restart them. stop_command cancels; view_image supplies pixels. Parallelize independent calls; compose_tools sequences steps and writes.",
		"Read current source before edits; reread stale rejections. Never invent truncated source. Choose the least expensive safe workflow; use LSP when semantic uncertainty warrants it. search_tools finds only unlisted tools. Outlines locate, not replace source.",
		"Use scoped read_repository_guidance; read required bodies completely with truncation cursors. Do not reread entire files just written; inventory with inspect_changes view:stat, review scoped full diffs. Reread uncertain regions.",
		"Run the smallest executable reproduction before extensive test scaffolding. Derive expected behavior from requirements, not your patch. Fix one coherent behavior and immediately check it before expanding. Do not front-load redesign. Then persist regression coverage in existing suites; without a suite, prefer compact reproducible checks. Cover interactions; never weaken tests or invent semantics.",
		"Batch edits/checks; apply_patches.verification only when offered, else compose_tools or run_checks. Use the configured formatter; otherwise match existing style, never invent line limits or polish untouched code. Biome: --error-on-warnings, no unsafe fixes.",
		"Use run_checks outputView:summary; retrieve logs for failures, warnings or uncertainty. Preserve every required check and full evidence. Each command needs its actual exit and stop status and output reference. After final review and required checks pass on the stable tree, finish unless a concrete defect remains.",
	].join(" ");
}
