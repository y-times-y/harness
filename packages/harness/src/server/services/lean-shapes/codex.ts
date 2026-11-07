import { type ToolSet, tool } from "ai";
import { z } from "zod";
import { LEAN_SHAPE_TOOLS } from "../../../domain/harness-model-profile";
import {
	LEAN_COMMAND_MAX_SECONDS,
	LEAN_YIELD_MAX_SECONDS,
	type LeanCommandResult,
	type LeanEngine,
} from "../lean-engine";
import { LEAN_MAX_BYTES } from "../lean-output";
import {
	BACKGROUND_OPTION_DESCRIPTION,
	COMMAND_MAX_CHARACTERS,
	directoryArgument,
	exitText,
	imageOutput,
	pathArgument,
	readForModel,
	textOutput,
	withNote,
} from "./common";

/** The "codex" shape's tools: a PTY-style session shell, freeform apply_patch, view_image. */
export function codexTools(engine: LeanEngine, base: ToolSet): ToolSet {
	const names = LEAN_SHAPE_TOOLS.codex;
	const view = (result: LeanCommandResult) =>
		withNote(
			[
				`Wall time: ${result.wallSeconds} seconds`,
				result.status === "running" && result.background
					? `Process running in the background with session ID ${result.id}; you are told when it exits, so do not poll it`
					: result.status === "running"
						? `Process running with session ID ${result.id}`
						: result.status === "interrupted"
							? "Process was interrupted"
							: `Process exited with code ${exitText(result)}`,
				"Output:",
				result.output,
			].join("\n"),
			result,
		);
	const tokensToBytes = (tokens?: number) =>
		tokens ? Math.min(LEAN_MAX_BYTES, Math.max(400, tokens * 4)) : undefined;
	const patch = base.apply_patch;
	const freeform =
		(patch as { id?: string } | undefined)?.id === "openai.custom" ||
		patch?.type === "provider";
	return {
		[names.command]: tool({
			description:
				"Runs a command in a PTY, returning output or a session ID for ongoing interaction.",
			inputSchema: z.object({
				cmd: z
					.string()
					.min(1)
					.max(COMMAND_MAX_CHARACTERS)
					.describe("Shell command to execute."),
				workdir: directoryArgument(
					"Optional working directory to run the command in; defaults to the repository root.",
				),
				yield_time_ms: z
					.number()
					.int()
					.min(0)
					.max(LEAN_COMMAND_MAX_SECONDS * 1000)
					.optional()
					.describe(
						`How long to wait (in milliseconds) for output before yielding (default 10000, at most ${LEAN_YIELD_MAX_SECONDS * 1000}).`,
					),
				max_output_tokens: z
					.number()
					.int()
					.min(1)
					.max(100_000)
					.optional()
					.describe(
						"Maximum number of tokens to return. Excess output will be truncated.",
					),
				background: z
					.boolean()
					.optional()
					.describe(BACKGROUND_OPTION_DESCRIPTION),
			}),
			execute: (
				{ cmd, workdir, yield_time_ms, max_output_tokens, background },
				options,
			) =>
				engine.run(
					{
						command: cmd,
						workdir,
						maxSeconds: LEAN_COMMAND_MAX_SECONDS,
						yieldSeconds: (yield_time_ms ?? 10_000) / 1000,
						maxBytes: tokensToBytes(max_output_tokens),
						background,
					},
					options,
				),
			toModelOutput: ({ output }) =>
				textOutput(view(output as LeanCommandResult)),
		}),
		[names.stdin]: tool({
			description:
				'Writes characters to an existing exec session and returns its output since the last read. Empty chars polls (waits up to yield_time_ms, or until it exits). "\\u0003" (Ctrl-C) stops the process; "\\u0004" sends EOF.',
			inputSchema: z.object({
				session_id: z
					.string()
					.min(1)
					.max(100)
					.describe("Session ID returned by exec_command."),
				chars: z
					.string()
					.max(8192)
					.optional()
					.describe("Bytes to write to stdin (may be empty to poll)."),
				yield_time_ms: z
					.number()
					.int()
					.min(0)
					.max(LEAN_COMMAND_MAX_SECONDS * 1000)
					.optional()
					.describe(
						"How long to wait (in milliseconds) for output before yielding.",
					),
				max_output_tokens: z
					.number()
					.int()
					.min(1)
					.max(100_000)
					.optional()
					.describe(
						"Maximum number of tokens to return. Excess output will be truncated.",
					),
			}),
			execute: async (
				{ session_id, chars, yield_time_ms, max_output_tokens },
				options,
			) => {
				if (!z.uuid().safeParse(session_id).success)
					throw new Error(
						`Unknown session ID ${JSON.stringify(session_id)}; use the ID exec_command returned.`,
					);
				return engine.write(
					{
						id: session_id,
						chars: chars ?? "",
						yieldSeconds:
							yield_time_ms === undefined
								? chars
									? 10
									: undefined
								: yield_time_ms / 1000,
						maxBytes: tokensToBytes(max_output_tokens),
					},
					options,
				);
			},
			toModelOutput: ({ output }) =>
				textOutput(view(output as LeanCommandResult)),
		}),
		...(patch
			? {
					// The runtime's apply_patch, which also accepts absolute paths inside
					// the repository (patch-input.ts repositoryPatchPath).
					[names.edit]: freeform
						? patch
						: tool({
								description:
									"Use the `apply_patch` tool to edit files. The patch is a stripped-down, file-oriented diff:\n*** Begin Patch\n[ one or more file sections ]\n*** End Patch\nEach section starts with *** Add File: <path> (every following line starts with +), *** Delete File: <path>, or *** Update File: <path> (optionally followed by *** Move to: <path>), then hunks introduced by @@ (optionally @@ <enclosing class or function>), with 3 lines of context before and after each change, ' ' for context, '-' for removed and '+' for added lines. File paths are relative to the repository root.",
								inputSchema: z.object({
									input: z
										.string()
										.min(1)
										.max(200_000)
										.describe(
											"The entire contents of the apply_patch command.",
										),
								}),
								execute: async ({ input }, options) => {
									const execute = patch.execute;
									if (!execute) throw new Error("apply_patch is unavailable.");
									return execute({ patch: input } as never, options);
								},
							}),
				}
			: {}),
		[names.image]: tool({
			description:
				"Attach a local image (by filesystem path) to the conversation context for this turn.",
			inputSchema: z.object({
				path: pathArgument("Local filesystem path to an image file"),
			}),
			execute: async ({ path }) => {
				const read = await readForModel(engine, "core", path, 1, 1);
				if (typeof read === "string" || !("image" in read))
					throw new Error(`${path} is not a PNG, JPEG, GIF or WebP image.`);
				return read;
			},
			toModelOutput: ({ output }) => imageOutput(output) ?? textOutput(output),
		}),
	};
}
