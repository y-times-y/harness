import { type ToolSet, tool } from "ai";
import { z } from "zod";
import { LEAN_SHAPE_TOOLS } from "../../../domain/harness-model-profile";
import { posixShellQuoted as quote } from "../../../domain/posix-command";
import {
	LEAN_COMMAND_MAX_SECONDS,
	LEAN_YIELD_MAX_SECONDS,
	type LeanCommandResult,
	type LeanEngine,
} from "../lean-engine";
import {
	backgroundHint,
	COMMAND_MAX_CHARACTERS,
	directoryArgument,
	EDIT_TEXT_MAX_CHARACTERS,
	exitText,
	globCommand,
	imageOutput,
	leanEdit,
	outputSoFar,
	pathArgument,
	readForModel,
	textOutput,
	WRITE_CONTENT_MAX_CHARACTERS,
	withNote,
	writeFile,
} from "./common";

/** The "gemini" shape's tools; the "qwen" shape names its edit tool `edit` with replace_all. */
export function geminiTools(engine: LeanEngine, qwen: boolean): ToolSet {
	const names = LEAN_SHAPE_TOOLS[qwen ? "qwen" : "gemini"];
	const editSchema = {
		file_path: pathArgument("The path to the file to modify."),
		old_string: z
			.string()
			.max(EDIT_TEXT_MAX_CHARACTERS)
			.describe(
				"The exact literal text to replace, including whitespace and indentation.",
			),
		new_string: z
			.string()
			.max(EDIT_TEXT_MAX_CHARACTERS)
			.describe("The exact literal text to replace old_string with."),
	};
	const editDescription = (flag: string) =>
		`Replaces text within a file. old_string must match exactly one occurrence (copy it with its whitespace and indentation, with enough surrounding context to be unique) unless ${flag} is true. An empty old_string creates a new file.`;
	return {
		[names.command]: tool({
			description:
				"Executes a shell command as `bash -c <command>` in the workspace and returns its output and exit code. dir_path runs it in that directory (default: the repository root). is_background starts servers, watchers and long jobs and returns their ID and output file at once; you are told when they finish, so do not poll them.",
			inputSchema: z.object({
				command: z
					.string()
					.min(1)
					.max(COMMAND_MAX_CHARACTERS)
					.describe("Exact bash command to execute as `bash -c <command>`"),
				description: z
					.string()
					.max(500)
					.optional()
					.describe("Brief description of the command for the user."),
				dir_path: directoryArgument(
					"Directory to run the command in (default: the repository root).",
				),
				is_background: z
					.boolean()
					.optional()
					.describe("Run the command in the background."),
			}),
			execute: ({ command, dir_path, is_background }, options) =>
				engine.run(
					is_background
						? {
								command,
								workdir: dir_path,
								maxSeconds: LEAN_COMMAND_MAX_SECONDS,
								yieldSeconds: 0,
								background: true,
							}
						: {
								command,
								workdir: dir_path,
								maxSeconds: LEAN_COMMAND_MAX_SECONDS,
								yieldSeconds: LEAN_YIELD_MAX_SECONDS,
								waitSeconds: LEAN_COMMAND_MAX_SECONDS,
							},
					options,
				),
			toModelOutput: ({ output, input }) => {
				const result = output as LeanCommandResult;
				const args = input as { dir_path?: string };
				if (result.status === "running")
					return textOutput(
						`Command started in background with ID ${result.id}. ${backgroundHint(result)}${outputSoFar(result)}`,
					);
				return textOutput(
					withNote(
						[
							`Command: ${result.command}`,
							`Directory: ${args?.dir_path || "(root)"}`,
							`Output: ${result.output || "(empty)"}`,
							`Exit Code: ${exitText(result)}`,
						].join("\n"),
						result,
					),
				);
			},
		}),
		[names.read]: tool({
			description:
				"Reads a file (absolute, or relative to the repository root). start_line and end_line (1-based, inclusive) select lines; at most 2000 lines are returned. Images (PNG, JPEG, GIF, WebP) are returned as images.",
			inputSchema: z.object({
				file_path: pathArgument("The path to the file to read."),
				start_line: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe("The 1-based line number to start reading from."),
				end_line: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe("The 1-based line number to end reading at (inclusive)."),
			}),
			execute: ({ file_path, start_line, end_line }) =>
				readForModel(
					engine,
					"gemini",
					file_path,
					start_line,
					end_line ? end_line - (start_line ?? 1) + 1 : undefined,
				),
			toModelOutput: ({ output }) => imageOutput(output) ?? textOutput(output),
		}),
		[names.write]: tool({
			description:
				"Writes content to a file, creating it (and parent directories) or overwriting it.",
			inputSchema: z.object({
				file_path: pathArgument("The path to the file to write to."),
				content: z
					.string()
					.max(WRITE_CONTENT_MAX_CHARACTERS)
					.describe("The content to write to the file."),
			}),
			execute: (args, options) =>
				writeFile(
					engine,
					names.write,
					args,
					options,
					args.file_path,
					args.content,
				),
		}),
		...(qwen
			? {
					[names.edit]: tool({
						description: editDescription("replace_all"),
						inputSchema: z.object({
							...editSchema,
							replace_all: z
								.boolean()
								.optional()
								.describe(
									"Replace all occurrences of old_string (default false).",
								),
						}),
						execute: (args, options) =>
							leanEdit(
								engine,
								names.edit,
								args,
								options,
								args.file_path,
								{
									old: args.old_string,
									new: args.new_string,
									all: args.replace_all,
								},
								{ old: "old_string", all: "replace_all" },
							),
					}),
				}
			: {
					[names.edit]: tool({
						description: editDescription("allow_multiple"),
						inputSchema: z.object({
							...editSchema,
							allow_multiple: z
								.boolean()
								.optional()
								.describe(
									"Replace every occurrence of old_string (default false).",
								),
						}),
						execute: (args, options) =>
							leanEdit(
								engine,
								names.edit,
								args,
								options,
								args.file_path,
								{
									old: args.old_string,
									new: args.new_string,
									all: args.allow_multiple,
								},
								{ old: "old_string", all: "allow_multiple" },
							),
					}),
				}),
		[names.glob]: tool({
			description:
				'Finds files matching a glob pattern (e.g. "src/**/*.ts"), most recently modified first.',
			inputSchema: z.object({
				pattern: z
					.string()
					.min(1)
					.max(1000)
					.describe("The glob pattern to match against."),
				dir_path: directoryArgument(
					"The directory to search within (default: the repository root).",
				),
			}),
			execute: ({ pattern, dir_path }) =>
				engine.search(globCommand(pattern, dir_path), "No files found"),
		}),
		[names.grep]: tool({
			description:
				"Searches file contents for a regular expression (ripgrep) and returns matching lines with file paths and line numbers.",
			inputSchema: z.object({
				pattern: z
					.string()
					.min(1)
					.max(2000)
					.describe("The regular expression to search for."),
				dir_path: directoryArgument(
					"The directory to search within (default: the repository root).",
				),
				include: z
					.string()
					.max(1000)
					.optional()
					.describe(
						'A glob pattern to filter files (e.g. "*.js", "src/**/*.{ts,tsx}").',
					),
			}),
			execute: ({ pattern, dir_path, include }) =>
				engine.search(
					`rg --hidden --no-messages --max-columns=500 --max-columns-preview -n -g '!.git' ${include ? `-g ${quote(include)} ` : ""}-e ${quote(pattern)} -- ${quote(dir_path || ".")}`,
					`No matches found for pattern "${pattern}".`,
				),
		}),
	};
}
