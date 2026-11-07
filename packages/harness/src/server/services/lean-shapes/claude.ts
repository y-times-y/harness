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

/** The "claude" shape's tools. */
export function claudeTools(engine: LeanEngine): ToolSet {
	const names = LEAN_SHAPE_TOOLS.claude;
	return {
		[names.command]: tool({
			description: `Executes a bash command in the workspace and returns its output. Each call starts in the repository root; the filesystem persists. timeout is in milliseconds (default 120000, max ${LEAN_COMMAND_MAX_SECONDS * 1000}). Set run_in_background to start servers, watchers and long jobs and get their ID and output file at once; you are told when they finish, so do not poll them.`,
			inputSchema: z.object({
				command: z
					.string()
					.min(1)
					.max(COMMAND_MAX_CHARACTERS)
					.describe("The command to execute"),
				timeout: z
					.number()
					.int()
					.min(1)
					.max(LEAN_COMMAND_MAX_SECONDS * 1000)
					.optional()
					.describe(
						`Optional timeout in milliseconds (max ${LEAN_COMMAND_MAX_SECONDS * 1000})`,
					),
				description: z
					.string()
					.max(500)
					.optional()
					.describe(
						"Clear, concise description of what this command does in 5-10 words",
					),
				run_in_background: z
					.boolean()
					.optional()
					.describe("Set to true to run this command in the background."),
			}),
			execute: ({ command, timeout, run_in_background }, options) => {
				const seconds = (timeout ?? 120_000) / 1000;
				return engine.run(
					run_in_background
						? {
								command,
								maxSeconds: LEAN_COMMAND_MAX_SECONDS,
								yieldSeconds: 0,
								background: true,
							}
						: {
								command,
								maxSeconds: seconds,
								yieldSeconds: Math.min(LEAN_YIELD_MAX_SECONDS, seconds),
								waitSeconds: seconds,
							},
					options,
				);
			},
			toModelOutput: ({ output }) => {
				const result = output as LeanCommandResult;
				if (result.status === "running")
					return textOutput(
						`Command running in background with ID: ${result.id}. ${backgroundHint(result)}${outputSoFar(result)}`,
					);
				return textOutput(
					withNote(
						[
							result.output || "(no output)",
							result.status === 0 ? "" : `Exit code ${exitText(result)}`,
						]
							.filter(Boolean)
							.join("\n"),
						result,
					),
				);
			},
		}),
		[names.read]: tool({
			description:
				"Reads a file. file_path should be absolute (relative paths resolve from the repository root). Returns up to 2000 lines in cat -n format, starting at offset (a 1-based line number) for up to limit lines; longer lines are cut at 2000 characters. Images (PNG, JPEG, GIF, WebP) are shown to you as images.",
			inputSchema: z.object({
				file_path: pathArgument("The absolute path to the file to read"),
				offset: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe("The line number to start reading from"),
				limit: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe("The number of lines to read"),
			}),
			execute: ({ file_path, offset, limit }) =>
				readForModel(engine, "claude", file_path, offset, limit),
			toModelOutput: ({ output }) => imageOutput(output) ?? textOutput(output),
		}),
		[names.write]: tool({
			description:
				"Writes a file, replacing it if it exists and creating parent directories. Prefer Edit for changes to existing files.",
			inputSchema: z.object({
				file_path: pathArgument("The absolute path to the file to write"),
				content: z
					.string()
					.max(WRITE_CONTENT_MAX_CHARACTERS)
					.describe("The content to write to the file"),
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
		[names.edit]: tool({
			description:
				"Performs an exact string replacement in a file. old_string must match exactly one place (include surrounding lines to make it unique) unless replace_all is true. An empty old_string creates a new file.",
			inputSchema: z.object({
				file_path: pathArgument("The absolute path to the file to modify"),
				old_string: z
					.string()
					.max(EDIT_TEXT_MAX_CHARACTERS)
					.describe("The text to replace"),
				new_string: z
					.string()
					.max(EDIT_TEXT_MAX_CHARACTERS)
					.describe(
						"The text to replace it with (must be different from old_string)",
					),
				replace_all: z
					.boolean()
					.optional()
					.describe("Replace all occurrences of old_string (default false)"),
			}),
			execute: (args, options) =>
				leanEdit(
					engine,
					names.edit,
					args,
					options,
					args.file_path,
					{ old: args.old_string, new: args.new_string, all: args.replace_all },
					{ old: "old_string", all: "replace_all" },
				),
		}),
		[names.glob]: tool({
			description:
				'Fast file pattern matching (e.g. "**/*.js" or "src/**/*.ts"). Returns matching file paths, most recently modified first.',
			inputSchema: z.object({
				pattern: z
					.string()
					.min(1)
					.max(1000)
					.describe("The glob pattern to match files against"),
				path: directoryArgument(
					"The directory to search in (default: the repository root)",
				),
			}),
			execute: ({ pattern, path }) =>
				engine.search(globCommand(pattern, path), "No files found"),
		}),
		[names.grep]: tool({
			description:
				"Searches file contents with ripgrep (regular expressions). output_mode: files_with_matches (default) lists files, content shows matching lines, count shows match counts.",
			inputSchema: z.object({
				pattern: z
					.string()
					.min(1)
					.max(2000)
					.describe("The regular expression pattern to search for"),
				path: directoryArgument(
					"File or directory to search in (default: the repository root)",
				),
				glob: z
					.string()
					.max(1000)
					.optional()
					.describe('Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}")'),
				output_mode: z
					.enum(["content", "files_with_matches", "count"])
					.optional(),
				"-i": z.boolean().optional().describe("Case insensitive search"),
				"-C": z
					.number()
					.int()
					.min(0)
					.max(50)
					.optional()
					.describe("Lines of context around each match (content mode)"),
				head_limit: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe("Limit output to the first N lines or entries"),
			}),
			execute: (args) => {
				const mode = args.output_mode ?? "files_with_matches";
				const flags = [
					"--hidden",
					"--no-messages",
					"--max-columns=500",
					"--max-columns-preview",
					"-g",
					"!.git",
					...(mode === "files_with_matches"
						? ["-l"]
						: mode === "count"
							? ["-c"]
							: ["-n"]),
					...(args["-i"] ? ["-i"] : []),
					...(mode === "content" && args["-C"] !== undefined
						? ["-C", String(args["-C"])]
						: []),
					...(args.glob ? ["-g", args.glob] : []),
				];
				return engine.search(
					`rg ${flags.map(quote).join(" ")} -e ${quote(args.pattern)} -- ${quote(args.path || ".")}${args.head_limit ? ` | head -n ${args.head_limit}` : ""}`,
					"No matches found",
				);
			},
		}),
	};
}
