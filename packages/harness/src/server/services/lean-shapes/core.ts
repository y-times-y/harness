import { type ToolSet, tool } from "ai";
import { z } from "zod";
import { LEAN_SHAPE_TOOLS } from "../../../domain/harness-model-profile";
import { applyLeanEdits } from "../lean-edit";
import {
	LEAN_COMMAND_DEFAULT_SECONDS,
	LEAN_COMMAND_MAX_SECONDS,
	LEAN_YIELD_MAX_SECONDS,
	type LeanCommandResult,
	type LeanEngine,
} from "../lean-engine";
import {
	BACKGROUND_OPTION_DESCRIPTION,
	backgroundHint,
	COMMAND_MAX_CHARACTERS,
	EDIT_TEXT_MAX_CHARACTERS,
	exitText,
	imageOutput,
	outputSoFar,
	pathArgument,
	readForModel,
	textOutput,
	WRITE_CONTENT_MAX_CHARACTERS,
	withNote,
	writeFile,
} from "./common";

/** Our core four tools (read, write, edit, bash): one neutral shape for every model. */
export function coreTools(engine: LeanEngine): ToolSet {
	const names = LEAN_SHAPE_TOOLS.core;
	return {
		[names.read]: tool({
			description:
				"Show a file. Text comes back as lines (at most 2000 lines or 50 KB per call; page through a long file with offset and limit). A jpg, png, gif or webp image comes back as the image itself.",
			inputSchema: z.object({
				path: pathArgument(
					"File to show, relative to the repository root or absolute",
				),
				offset: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe("First line to show, counting from 1"),
				limit: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe("How many lines to show at most"),
			}),
			execute: ({ path, offset, limit }) =>
				readForModel(engine, "core", path, offset, limit),
			toModelOutput: ({ output }) => imageOutput(output) ?? textOutput(output),
		}),
		[names.write]: tool({
			description:
				"Replace a file's whole content, creating the file and any missing directories when needed.",
			inputSchema: z.object({
				path: pathArgument(
					"File to write, relative to the repository root or absolute",
				),
				content: z
					.string()
					.max(WRITE_CONTENT_MAX_CHARACTERS)
					.describe("The complete new content of the file"),
			}),
			execute: (args, options) =>
				writeFile(engine, names.write, args, options, args.path, args.content),
		}),
		[names.edit]: tool({
			description:
				"Change one file by swapping text. Every old_string is matched against the file as it stood before this call, never against the result of another edit in the same call, and must appear exactly once; no two edits may cover the same text. Group all changes to one file into a single call.",
			inputSchema: z.object({
				path: pathArgument(
					"File to change, relative to the repository root or absolute",
				),
				edits: z
					.array(
						z.object({
							old_string: z
								.string()
								.min(1)
								.max(EDIT_TEXT_MAX_CHARACTERS)
								.describe("Text currently in the file, copied exactly"),
							new_string: z
								.string()
								.max(EDIT_TEXT_MAX_CHARACTERS)
								.describe("Text that replaces old_string"),
						}),
					)
					.min(1)
					.max(50),
			}),
			execute: (args, options) =>
				engine.once(names.edit, args, options, async () => {
					const edited = await engine.editFile(args.path, (content) =>
						applyLeanEdits(content, args.edits, args.path),
					);
					return `Updated ${edited.path}: ${edited.replacements} ${edited.replacements === 1 ? "edit" : "edits"} applied.${edited.fuzzy ? " The text matched after normalizing whitespace, quotes or dashes; only the matched regions changed." : ""}`;
				}),
		}),
		[names.command]: tool({
			description: `Run a bash command from the repository root and wait for it to finish. You get stdout and stderr together; past 2000 lines or 50 KB only the end is shown and the rest is kept in a file. timeout stops the command after that many seconds (default ${LEAN_COMMAND_DEFAULT_SECONDS}, at most ${LEAN_COMMAND_MAX_SECONDS}). Set background to start servers, watchers and long jobs; you are told when they finish.`,
			inputSchema: z.object({
				command: z
					.string()
					.min(1)
					.max(COMMAND_MAX_CHARACTERS)
					.describe("The command to run"),
				timeout: z
					.number()
					.min(1)
					.max(LEAN_COMMAND_MAX_SECONDS)
					.optional()
					.describe(
						`Seconds before the command is stopped (default ${LEAN_COMMAND_DEFAULT_SECONDS}, at most ${LEAN_COMMAND_MAX_SECONDS})`,
					),
				background: z
					.boolean()
					.optional()
					.describe(BACKGROUND_OPTION_DESCRIPTION),
			}),
			execute: ({ command, timeout, background }, options) => {
				const seconds = timeout ?? LEAN_COMMAND_DEFAULT_SECONDS;
				return engine.run(
					{
						command,
						maxSeconds: seconds,
						yieldSeconds: Math.min(LEAN_YIELD_MAX_SECONDS, seconds),
						waitSeconds: seconds,
						background,
					},
					options,
				);
			},
			toModelOutput: ({ output }) => {
				const result = output as LeanCommandResult;
				if (result.status === "running" && result.background)
					return textOutput(
						`Started in the background (ID ${result.id}). ${backgroundHint(result)}${outputSoFar(result)}`,
					);
				if (result.status === "running")
					return textOutput(
						`Still running after ${result.wallSeconds} seconds (ID ${result.id}). ${backgroundHint(result)}${outputSoFar(result)}`,
					);
				return textOutput(
					withNote(
						[
							result.output || "(no output)",
							result.stopped === "timeout"
								? `Command timed out (exit ${result.status})`
								: result.status === 0
									? ""
									: `Command exited with code ${exitText(result)}`,
						]
							.filter(Boolean)
							.join("\n\n"),
						result,
					),
				);
			},
		}),
	};
}
