import { detectMediaType } from "@ai-sdk/provider-utils";
import type { Tool } from "ai";
import { z } from "zod";
import { posixShellQuoted as quote } from "../../../domain/posix-command";
import {
	AGENT_OUTPUT_LIMIT_BYTES,
	COMMAND_MAX_CHARACTERS,
} from "../agent-output-artifacts";
import { applyLeanEdit, type LeanEditNames } from "../lean-edit";
import type { LeanCommandResult, LeanEngine } from "../lean-engine";
import { LEAN_MAX_LINES } from "../lean-output";
import { GLOB_RESULTS_SCRIPT } from "../lean-scripts";

/** What every lean shape (codex.ts, claude.ts, gemini.ts, core.ts) shares. */

export type ExecuteOptions = Parameters<NonNullable<Tool["execute"]>>[1];

/** The longest path a lean tool accepts. */
const PATH_MAX_CHARACTERS = 4096;

/** The longest shell command a lean tool accepts (as execute_command). */
export { COMMAND_MAX_CHARACTERS };
/** The longest old/new text an edit accepts, and the longest whole file a write accepts. */
export const EDIT_TEXT_MAX_CHARACTERS = 1_000_000;
export const WRITE_CONTENT_MAX_CHARACTERS = 5_000_000;

/** A required file path argument. */
export const pathArgument = (description: string) =>
	z.string().min(1).max(PATH_MAX_CHARACTERS).describe(description);

/** An optional directory argument (default: the repository root). */
export const directoryArgument = (description: string) =>
	z.string().max(PATH_MAX_CHARACTERS).optional().describe(description);

export const imageOutput = (output: unknown) => {
	const read = output as { image?: string; base64?: string; path?: string };
	return read.image && read.base64
		? {
				type: "content" as const,
				value: [
					{ type: "text" as const, text: `Image ${read.path}` },
					{
						type: "file" as const,
						data: { type: "data" as const, data: read.base64 },
						mediaType: read.image,
					},
				],
			}
		: null;
};

export const textOutput = (value: unknown) => ({
	type: "text" as const,
	value: typeof value === "string" ? value : JSON.stringify(value),
});

export type ReadView = "claude" | "gemini" | "core";

/** A file read in each harness's own format; images as images. */
export async function readForModel(
	engine: LeanEngine,
	view: ReadView,
	path: string,
	offset: number | undefined,
	limit: number | undefined,
) {
	const start = offset && offset > 0 ? offset : 1;
	const read = await engine.readFile(path, {
		offset: start,
		limit: Math.min(
			limit && limit > 0 ? limit : LEAN_MAX_LINES,
			LEAN_MAX_LINES,
		),
		maxLineCharacters: view === "claude" ? 2000 : 0,
	});
	if ("missing" in read) throw new Error(`File does not exist: ${read.path}`);
	if ("directory" in read)
		throw new Error(
			`${read.path} is a directory, not a file. It contains: ${read.entries.join(", ")}`,
		);
	if ("binary" in read)
		throw new Error(`${read.path} is a binary file (${read.bytes} bytes).`);
	if ("error" in read) throw new Error(`${read.path}: ${read.error}.`);
	if ("image" in read) {
		const mediaType = detectMediaType({
			data: read.base64,
			topLevelType: "image",
		});
		return { ...read, image: mediaType ?? read.image };
	}
	const last = read.startLine + read.lines.length - 1;
	const more = read.cut || last < read.totalLines;
	if (!read.lines.length) {
		if (read.totalLines === 0)
			return view === "claude"
				? "<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>"
				: "(empty file)";
		throw new Error(
			`${view === "gemini" ? "start_line" : "offset"} ${start} is beyond the end of ${read.path} (${read.totalLines} lines).`,
		);
	}
	const body =
		view === "claude"
			? read.lines
					.map(
						(line, index) =>
							`${String(read.startLine + index).padStart(6)}\t${line}`,
					)
					.join("\n")
			: read.lines.join("\n");
	if (!more) return body;
	const next = last + 1;
	return view === "gemini"
		? `IMPORTANT: The file content has been truncated.\nStatus: Showing lines ${read.startLine}-${last} of ${read.totalLines} total lines.\nAction: To read more of the file, use start_line: ${next}.\n\n--- FILE CONTENT (truncated) ---\n${body}`
		: `${body}\n\n[Lines ${read.startLine}-${last} of ${read.totalLines}; read on from offset ${next}.]`;
}

export const editNote = (
	edited: { replacements: number; fuzzy: boolean },
	path: string,
	created: boolean,
) =>
	created
		? `Created ${path}.`
		: `The file ${path} has been updated (${edited.replacements} ${edited.replacements === 1 ? "replacement" : "replacements"}).${edited.fuzzy ? " The text matched after normalizing whitespace, quotes or dashes; only the matched region changed." : ""}`;

export async function leanEdit(
	engine: LeanEngine,
	name: string,
	args: Record<string, unknown>,
	options: ExecuteOptions,
	path: string,
	edit: { old: string; new: string; all?: boolean },
	names: LeanEditNames,
) {
	return engine.once(name, args, options, async () => {
		const edited = await engine.editFile(path, (content) =>
			applyLeanEdit(content, edit, path, names),
		);
		return editNote(edited, edited.path, edited.created);
	});
}

export const writeFile = (
	engine: LeanEngine,
	name: string,
	args: Record<string, unknown>,
	options: ExecuteOptions,
	path: string,
	content: string,
) =>
	engine.once(name, args, options, async () => {
		const written = await engine.writeFile(path, content);
		return `${written.created ? "Created" : "Overwrote"} ${written.path} (${written.lines} lines).`;
	});

/** How to follow a command left running in the background (ytimesy-job). */
export const backgroundHint = (result: LeanCommandResult) =>
	result.background
		? `Output is being written to ${result.outputPath}. You will be told when it exits; do not poll it. Stop it with \`ytimesy-job stop ${result.id}\`.`
		: `Output is being written to ${result.outputPath}. Check it with \`ytimesy-job status ${result.id}\`, wait for it with \`ytimesy-job wait ${result.id}\`, stop it with \`ytimesy-job stop ${result.id}\`.`;

/** The background option's description, shared by the shapes that add one. */
export const BACKGROUND_OPTION_DESCRIPTION =
	"Start it in the background (servers, watchers, long jobs) and return its ID at once. It runs until it exits or is stopped; you are told when it finishes, so do not poll it.";

/** Output a still-running command printed so far, as a trailing paragraph. */
export const outputSoFar = (result: LeanCommandResult) =>
	result.output ? `\nOutput so far:\n${result.output}` : "";

export const exitText = (result: LeanCommandResult) =>
	result.stopped === "timeout"
		? `${result.status} (stopped at its time limit)`
		: result.stopped === "output_limit"
			? `${result.status} (stopped: output exceeded ${AGENT_OUTPUT_LIMIT_BYTES / 1024 / 1024} MB)`
			: String(result.status);

export const withNote = (text: string, result: LeanCommandResult) =>
	[text, result.truncationNote, result.note].filter(Boolean).join("\n");

export const globCommand = (pattern: string, base: string | undefined) =>
	`rg --files --hidden --no-messages -g '!.git' -g ${quote(pattern)} --sortr modified -- ${quote(base || ".")} | head -n 101 | python3 -c ${quote(GLOB_RESULTS_SCRIPT)}`;
