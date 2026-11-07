import {
	asArray,
	asObject,
	asString,
	type JsonObject,
	parseJsonObject,
} from "./io.ts";
import type { ToolCall, ToolCallKind } from "./types.ts";

export const MAX_TOOL_OUTPUT_CHARS = 3000;
export const MAX_TOOL_INPUT_CHARS = 8000;

const SHELL_TOOLS = new Set([
	"bash",
	"shell",
	"shell_command",
	"exec_command",
	"container.exec",
	"local_shell",
	"local_shell_call",
	"run_terminal_command",
	"run_terminal_cmd",
	"run_shell_command",
	"run_terminal_command_v2",
	"terminal",
	"powershell",
]);
const EDIT_TOOLS = new Set([
	"edit",
	"multiedit",
	"multi_edit",
	"apply_patch",
	"patch",
	"search_replace",
	"str_replace",
	"str_replace_editor",
	"str_replace_based_edit_tool",
	"edit_file",
	"notebookedit",
	"notebook_edit",
	"replace",
	"strreplace",
	"applypatch",
	"edit_file_v2",
	"delete_file",
	"delete",
]);
const WRITE_TOOLS = new Set(["write", "write_file", "create_file", "create"]);
const READ_TOOLS = new Set([
	"read",
	"read_file",
	"view",
	"view_file",
	"cat",
	"notebookread",
	"view_image",
	"read_image",
	"read_many_files",
	"read_file_v2",
	"readfile",
]);
const SEARCH_TOOLS = new Set([
	"grep",
	"glob",
	"find",
	"search",
	"ls",
	"list",
	"list_dir",
	"list_directory",
	"list_files",
	"grep_files",
	"file_search",
	"codebase_search",
	"search_files",
	"search_file_content",
	"grep_search",
	"ripgrep_raw_search",
	"glob_file_search",
	"rg",
	"semanticsearch",
]);

const PATH_KEYS = [
	"file_path",
	"filePath",
	"path",
	"notebook_path",
	"target_file",
	"filename",
	"dir_path",
	"target_directory",
	"absolute_path",
	"relativeWorkspacePath",
	"targetFile",
	"targetDirectory",
	"directoryPath",
];

export function classifyToolName(name: string): ToolCallKind {
	const key = name.toLowerCase();
	if (SHELL_TOOLS.has(key)) return "shell";
	if (EDIT_TOOLS.has(key)) return "edit";
	if (WRITE_TOOLS.has(key)) return "write";
	if (READ_TOOLS.has(key)) return "read";
	if (SEARCH_TOOLS.has(key)) return "search";
	return "other";
}

export function truncateText(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n…(truncated, ${text.length - max} more chars)`;
}

export function stringifyValue(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === undefined) return "";
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return String(value);
	}
}

/** `["bash", "-lc", "ls"]` → `ls`; any other argv is joined with spaces. */
export function commandFromArgv(argv: string[]): string {
	const shellFlagIndex = argv.findIndex(
		(part) => part === "-lc" || part === "-c" || part === "-Command",
	);
	if (shellFlagIndex >= 1 && shellFlagIndex === argv.length - 2)
		return argv[argv.length - 1] ?? "";
	return argv.join(" ");
}

export function shellCommandFromInput(
	input: JsonObject | undefined,
): string | undefined {
	if (!input) return undefined;
	for (const key of ["command", "cmd", "commandLine"]) {
		const value = input[key];
		if (typeof value === "string" && value.trim()) return value.trim();
		if (
			Array.isArray(value) &&
			value.every((part) => typeof part === "string")
		) {
			const command = commandFromArgv(value as string[]).trim();
			if (command) return command;
		}
	}
	return undefined;
}

/** File paths named in an apply_patch body (`*** Update File: x`, `*** Add File: x`, ...). */
export function pathsFromPatch(patch: string): string[] {
	const paths: string[] = [];
	const pattern =
		/^\*\*\* (?:Update|Add|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm;
	for (const match of patch.matchAll(pattern)) {
		const found = (match[1] ?? match[2] ?? "").trim();
		if (found && !paths.includes(found)) paths.push(found);
	}
	return paths;
}

export function pathsFromInput(input: JsonObject | undefined): string[] {
	if (!input) return [];
	const paths: string[] = [];
	const add = (value: unknown) => {
		if (typeof value === "string" && value.trim() && !paths.includes(value))
			paths.push(value);
	};
	for (const key of PATH_KEYS) add(input[key]);
	for (const key of ["paths", "file_paths", "files"]) {
		for (const item of asArray(input[key]))
			add(typeof item === "string" ? item : asObject(item)?.path);
	}
	for (const edit of asArray(input.edits))
		add(asObject(edit)?.file_path ?? asObject(edit)?.path);
	for (const key of ["input", "patch"]) {
		const value = asString(input[key]);
		if (value?.includes("*** Begin Patch"))
			for (const found of pathsFromPatch(value)) add(found);
	}
	return paths;
}

/** Exit codes that tools print into output text instead of a structured field. */
export function exitCodeFromText(text: string | undefined): number | undefined {
	if (!text) return undefined;
	const match =
		/^(?:Error: )?Exit code:? (-?\d+)/im.exec(text) ??
		/Process exited with code (-?\d+)/.exec(text) ??
		/Command exited with code (-?\d+)/.exec(text);
	return match?.[1] === undefined ? undefined : Number(match[1]);
}

export interface ToolCallDraft {
	name: string;
	input: unknown;
	kind?: ToolCallKind;
}

/** Builds a ToolCall from a tool name and its raw input (object, JSON text or patch text). */
export function createToolCall(draft: ToolCallDraft): ToolCall {
	const inputObject =
		asObject(draft.input) ??
		(typeof draft.input === "string"
			? parseJsonObject(draft.input)
			: undefined);
	const inputText = stringifyValue(draft.input);
	let kind = draft.kind ?? classifyToolName(draft.name);
	if (kind === "other" && inputText.includes("*** Begin Patch")) kind = "edit";
	const paths = pathsFromInput(inputObject);
	if (paths.length === 0 && inputText.includes("*** Begin Patch"))
		paths.push(...pathsFromPatch(inputText));
	const call: ToolCall = {
		kind,
		name: draft.name,
		input: truncateText(inputText, MAX_TOOL_INPUT_CHARS),
		paths,
		changedPaths: kind === "edit" || kind === "write" ? [...paths] : [],
	};
	if (kind === "shell") {
		const command = shellCommandFromInput(inputObject);
		if (command) call.command = command;
	}
	return call;
}

export function setToolOutput(call: ToolCall, output: unknown): void {
	const text = stringifyValue(output);
	if (text) call.output = truncateText(text, MAX_TOOL_OUTPUT_CHARS);
}
