import type { ModelMessage, ToolSet } from "ai";
import {
	LEAN_SHAPE_TOOLS,
	type LeanToolShape,
	leanToolShape,
} from "../../domain/harness-model-profile";
import type { HarnessToolSurfaceId } from "../../domain/harness-variant";
import { writeLeanHistory } from "./lean-helpers";
import { type LeanSurfaceContext, leanShapeTools } from "./lean-tools";

/**
 * The shell-shaped builder surface: a shell, a patch tool and a few
 * essentials. Specialist tools (run_checks, apply_patches, inspect_changes,
 * plans) cost more turns than they saved. The prompt profile follows the tools.
 * Repository instructions arrive as conversation messages, not a tool call.
 */
export const BUILDER_SHELL_TOOLS: ReadonlySet<string> = new Set([
	"execute_command",
	"continue_command",
	"stop_command",
	"apply_patch",
	"view_image",
	"read_environment_report",
	"report_task_blocked",
	// Runs the deliverable from a clean copy before the builder says it is done.
	"check_deliverable",
	// Recover exact detail after compaction.
	"read_context_archive",
	"search_context_history",
	// Product-only: visual QA on the shared desktop. Unattended runs build
	// their own tool set, so these do not change this surface.
	"browser_open",
	"browser_screenshot",
	"browser_inspect",
	"browser_execute",
]);

export function builderShellTools(tools: ToolSet): ToolSet {
	return Object.fromEntries(
		Object.entries(tools).filter(([name]) => BUILDER_SHELL_TOOLS.has(name)),
	);
}

/** What a lean surface adds to the turn besides its tools. */
export type LeanBuilderSurface = {
	shape: LeanToolShape;
	/** A read-only subagent's surface: commands and reads, no file-changing tools. */
	readOnly: boolean;
	/** How runtime notices tell the model to read a background command's output. */
	commandReader: string;
	/** The completion gate's hint for commands still running. */
	waitHint: (ids: readonly string[]) => string;
	/** After compaction: writes the archived messages to ~/.ytimesy/history/ and returns the path to cite, or null if it could not. */
	saveHistory: (
		reference: string,
		messages: ModelMessage[],
	) => Promise<string | null>;
};

/**
 * The builder's tool surface, chosen per run (docs/builder-tool-surface.md).
 * "current" is the shell surface above. "lean-native" shows each
 * model family its own tool shape and "lean" shows every model our core four; both run on the
 * same command runner and limits, keep only report_task_blocked from `tools`
 * (MCP, web search, plugin skills, plan and secret tools are added by the
 * caller as before), and move the helpers to workspace commands.
 */
export function builderToolSurface(input: {
	variant: HarnessToolSurfaceId;
	modelId: string;
	tools: ToolSet;
	/** Used by the lean variants only. */
	lean: LeanSurfaceContext;
	/**
	 * A read-only subagent (researcher, reviewer, checker): its commands run
	 * as the reader user, and a lean shape's write and edit tools are left
	 * out because they could only fail.
	 */
	readOnly?: boolean;
}): { tools: ToolSet; lean?: LeanBuilderSurface } {
	if (input.variant === "current")
		return { tools: builderShellTools(input.tools) };
	const shape = leanToolShape(input.variant, input.modelId);
	const { tools, engine } = leanShapeTools(shape, input.tools, input.lean);
	const names: { stdin?: string; read?: string; write?: string; edit: string } =
		LEAN_SHAPE_TOOLS[shape];
	const changing = new Set(
		input.readOnly
			? [names.write, names.edit].filter(
					(name): name is string => !!name && name !== names.read,
				)
			: [],
	);
	return {
		tools: {
			...Object.fromEntries(
				Object.entries(tools).filter(([name]) => !changing.has(name)),
			),
			...(input.tools.report_task_blocked
				? { report_task_blocked: input.tools.report_task_blocked }
				: {}),
		},
		lean: {
			shape,
			readOnly: !!input.readOnly,
			commandReader: names.stdin
				? `${names.stdin} (its session_id)`
				: `${names.read} on ${engine.outputPath("<id>")}`,
			waitHint: (ids) =>
				names.stdin
					? `Use ${names.stdin} with each session_id to wait for them (\\u0003 stops one)`
					: `Wait with \`ytimesy-job wait <id>\` or stop with \`ytimesy-job stop <id>\` (ids: ${ids.join(", ")})`,
			saveHistory: async (reference, messages) => {
				try {
					return await writeLeanHistory(
						await input.lean.workspace(),
						reference,
						messages,
					);
				} catch (error) {
					console.warn("Conversation history file was not written.", error);
					return null;
				}
			},
		},
	};
}
