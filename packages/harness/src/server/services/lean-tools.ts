import type { ToolSet } from "ai";
import type { LeanToolShape } from "../../domain/harness-model-profile";
import {
	type LeanEngine,
	type LeanSurfaceContext,
	leanEngine,
} from "./lean-engine";
import { claudeTools } from "./lean-shapes/claude";
import { codexTools } from "./lean-shapes/codex";
import { coreTools } from "./lean-shapes/core";
import { geminiTools } from "./lean-shapes/gemini";

/**
 * The lean builder surfaces (docs/builder-tool-surface.md): each model family
 * sees the tool names and argument shapes of its own vendor harness (or our own
 * core four), over one shared engine (lean-engine.ts). Commands go through
 * the runtime's execute/continue/stop tools (same runner, limits, journal and
 * background tracking); edits through one exact-then-fuzzy matcher; every
 * output through one limit (2000 lines / 50 KB, head for reads, tail for
 * commands, with the full command output kept in a file). Tool names come
 * from LEAN_SHAPE_TOOLS; each shape lives in lean-shapes/.
 */

export type { LeanCommandResult, LeanSurfaceContext } from "./lean-engine";

/** The tools a lean shape offers, over the runtime's command tools in `base`. */
export function leanShapeTools(
	shape: LeanToolShape,
	base: ToolSet,
	context: LeanSurfaceContext,
): { tools: ToolSet; engine: LeanEngine } {
	const engine = leanEngine(base, context);
	const tools =
		shape === "codex"
			? codexTools(engine, base)
			: shape === "claude"
				? claudeTools(engine)
				: shape === "gemini" || shape === "qwen"
					? geminiTools(engine, shape === "qwen")
					: coreTools(engine);
	return { tools, engine };
}
