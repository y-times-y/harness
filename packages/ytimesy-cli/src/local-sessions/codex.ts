/**
 * Codex CLI / Codex Desktop rollouts: `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`
 * (CODEX_HOME defaults to ~/.codex; very old builds wrote `sessions/rollout-*.jsonl`).
 *
 * Shapes handled:
 * - Pre-wrapper (2025): first line `{id, timestamp, instructions, git?}`, then bare
 *   response items (`{type: "message" | "function_call" | ...}`) and `record_type`
 *   state lines. No cwd field; it is read from `<cwd>` in the environment context.
 * - Wrapped (agent-hop era, ~0.2x-0.15x): `{timestamp, type, payload}` lines with
 *   `session_meta` first, `response_item` (message, function_call / function_call_output,
 *   custom_tool_call / custom_tool_call_output, local_shell_call), `event_msg`
 *   (exec_command_end, patch_apply_end carry exit codes), `turn_context`, `compacted`.
 *   Shell tools: `shell` / `container.exec` (argv), `shell_command`, `exec_command`.
 * - Item events (verified on codex-cli 0.161.0 exec and Codex Desktop 0.160 / 0.165-alpha):
 *   code-mode `exec` wrapper calls whose real work is reported as
 *   `event_msg.item_completed` items: CommandExecution (argv, cwd as file:// URL,
 *   exit_code, aggregated_output), FileChange (changes keyed by absolute path),
 *   McpToolCall, Extension (web search), ImageView. When a rollout has these items, tool
 *   calls come from them and the wrapper calls are skipped. `compacted` with an empty
 *   `message` is a remote (encrypted) compaction with no plaintext summary.
 * An empty rollout file (created before the first turn was written) is skipped.
 * Compressed rollouts (`.jsonl.zst`, which Codex writes for older sessions) are read
 * the same way: discovery partly decompresses the head, a read decompresses the file.
 * Codex Desktop runs some sessions in its own git worktrees
 * (`$CODEX_HOME/worktrees/<id>/<repo>`); those match the repository they were made from
 * by git common directory, or by `origin` remote when the worktree is gone.
 */
import os from "node:os";
import path from "node:path";
import {
	type GitIdentity,
	gitIdentity,
	normalizeRemote,
	sameRepository,
} from "./git.ts";
import {
	asArray,
	asNumber,
	asObject,
	asString,
	canonicalPath,
	fileMtimeMs,
	fileUrlToPath,
	isPathInside,
	type JsonObject,
	linesBackward,
	linesForward,
	listDirectory,
	parseJsonObject,
	readFirstLine,
	readHeadText,
} from "./io.ts";
import {
	commandFromArgv,
	createToolCall,
	exitCodeFromText,
	MAX_TOOL_INPUT_CHARS,
	MAX_TOOL_OUTPUT_CHARS,
	setToolOutput,
	stringifyValue,
	truncateText,
} from "./tool-calls.ts";
import {
	approximateTextChars,
	type TranscriptScan,
	TurnAssembler,
	titleFromPrompt,
	transcriptReadMode,
	visitTranscriptRecords,
} from "./transcript.ts";
import type {
	LocalSession,
	ReaderOptions,
	SessionRef,
	ToolCall,
} from "./types.ts";

const HEAD_BYTES_FOR_CWD = 512 * 1024;
const ITEM_EVENT_PROBE_BYTES = 1024 * 1024;
const BARE_RESPONSE_ITEM_TYPES = new Set([
	"message",
	"function_call",
	"function_call_output",
	"custom_tool_call",
	"custom_tool_call_output",
	"local_shell_call",
	"reasoning",
]);
const INJECTED_USER_PREFIXES = [
	"<environment_context>",
	"<user_instructions>",
	"# AGENTS.md instructions",
	"<recommended_plugins>",
	"<permissions instructions>",
	"<turn_aborted>",
];
const IDE_CONTEXT_PREFIX = "# Context from my IDE";
const IDE_REQUEST_HEADING = "## My request for Codex:";

export function codexSessionsDirectory(home = os.homedir()): string {
	const codexHome = process.env.CODEX_HOME?.trim() || path.join(home, ".codex");
	return path.join(codexHome, "sessions");
}

export interface CodexSessionMeta {
	id?: string;
	cwd?: string;
	cliVersion?: string;
	gitBranch?: string;
	/** `git.repository_url` (older Codex builds record it; newer ones do not). */
	repositoryUrl?: string;
	startedAt?: string;
}

/** Session metadata from the first line (plus a head scan for `<cwd>` in pre-wrapper rollouts). */
export function readCodexSessionMeta(
	file: string,
): CodexSessionMeta | undefined {
	const firstLine = readFirstLine(file);
	if (!firstLine) return undefined;
	const first = parseJsonObject(firstLine);
	if (!first) return undefined;
	const payload =
		first.type === "session_meta" ? asObject(first.payload) : first;
	if (!payload) return undefined;
	const meta: CodexSessionMeta = {
		id: asString(payload.id) ?? asString(payload.session_id),
		cwd: asString(payload.cwd),
		cliVersion: asString(payload.cli_version),
		gitBranch: asString(asObject(payload.git)?.branch),
		repositoryUrl: asString(asObject(payload.git)?.repository_url),
		startedAt: asString(payload.timestamp) ?? asString(first.timestamp),
	};
	if (!meta.cwd) {
		const match = /<cwd>([^<]+)<\/cwd>/.exec(
			readHeadText(file, HEAD_BYTES_FOR_CWD),
		);
		meta.cwd = match?.[1]?.trim();
	}
	return meta;
}

function rolloutIdFromFileName(file: string): string {
	const match =
		/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/.exec(
			file,
		);
	return match?.[1] ?? path.basename(file).replace(/\.jsonl(?:\.zst)?$/, "");
}

/** `rollout-*.jsonl`, or `rollout-*.jsonl.zst` once Codex has compressed an older rollout. */
export function isRolloutFileName(name: string): boolean {
	return name.endsWith(".jsonl") || name.endsWith(".jsonl.zst");
}

export function listCodexRolloutFiles(
	sessionsDirectory: string,
): { file: string; mtime: number }[] {
	const files: { file: string; mtime: number }[] = [];
	const walk = (directory: string, depth: number) => {
		for (const entry of listDirectory(directory)) {
			const full = path.join(directory, entry.name);
			if (entry.isDirectory() && depth < 3) walk(full, depth + 1);
			else if (entry.isFile() && isRolloutFileName(entry.name))
				files.push({ file: full, mtime: fileMtimeMs(full) ?? 0 });
		}
	};
	walk(sessionsDirectory, 0);
	return files.sort((a, b) => b.mtime - a.mtime);
}

export function codexSessionRefForFile(
	file: string,
	mtime = fileMtimeMs(file) ?? 0,
): SessionRef | undefined {
	const meta = readCodexSessionMeta(file);
	if (!meta?.cwd) return undefined;
	return {
		tool: "codex",
		id: meta.id ?? rolloutIdFromFileName(file),
		cwd: meta.cwd,
		updatedAt: mtime,
		location: file,
	};
}

export function codexWorktreesDirectory(home = os.homedir()): string {
	return path.join(path.dirname(codexSessionsDirectory(home)), "worktrees");
}

/**
 * Whether a rollout made in a Codex Desktop worktree belongs to the repository: the
 * worktree shares its git common directory (or `origin`); when the worktree has been
 * removed, the rollout's recorded repository URL is compared with `origin`.
 */
function codexWorktreeMatches(
	cwd: string,
	file: string,
	repo: GitIdentity | undefined,
	worktreesDirectory: string,
): boolean {
	if (!repo || !isPathInside(cwd, worktreesDirectory)) return false;
	const identity = gitIdentity(cwd);
	if (identity) return sameRepository(identity, repo);
	const recorded = normalizeRemote(readCodexSessionMeta(file)?.repositoryUrl);
	return recorded !== undefined && recorded === repo.remote;
}

/**
 * Newest rollouts (up to `limit`) whose cwd is the repo root or inside it, or a Codex
 * Desktop worktree of the same repository. Reads only first lines, newest file first.
 */
export function discoverCodexSessions(
	repoRoot: string,
	home = os.homedir(),
	limit = 1,
): SessionRef[] {
	const root = canonicalPath(repoRoot);
	const worktreesDirectory = canonicalPath(codexWorktreesDirectory(home));
	let repo: GitIdentity | undefined | null = null;
	const refs: SessionRef[] = [];
	for (const { file, mtime } of listCodexRolloutFiles(
		codexSessionsDirectory(home),
	)) {
		const ref = codexSessionRefForFile(file, mtime);
		if (!ref) continue;
		const cwd = canonicalPath(ref.cwd);
		let matches = isPathInside(cwd, root);
		if (!matches && isPathInside(cwd, worktreesDirectory)) {
			if (repo === null) repo = gitIdentity(root);
			matches = codexWorktreeMatches(cwd, file, repo, worktreesDirectory);
		}
		if (!matches) continue;
		refs.push(ref);
		if (refs.length >= limit) break;
	}
	return refs;
}

export function unwrapRecord(
	record: JsonObject,
): { type: string; payload: JsonObject } | undefined {
	const type = asString(record.type);
	const payload = asObject(record.payload);
	if (type && payload) return { type, payload };
	if (type && BARE_RESPONSE_ITEM_TYPES.has(type))
		return { type: "response_item", payload: record };
	return undefined;
}

export function messageText(payload: JsonObject): string {
	return asArray(payload.content)
		.map((block) => asObject(block))
		.filter(
			(block) =>
				block &&
				["input_text", "output_text", "text"].includes(String(block.type)),
		)
		.map((block) => asString(block?.text) ?? "")
		.join("\n");
}

function isWholeTagBlock(text: string): boolean {
	return /^<([a-z_][a-z0-9_-]*)(?:\s[^>]*)?>[\s\S]*<\/\1>$/.test(text.trim());
}

/** What the person typed, with injected context removed; undefined for pure context messages. */
export function codexUserPromptText(text: string): string | undefined {
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	if (trimmed.startsWith(IDE_CONTEXT_PREFIX)) {
		const index = trimmed.indexOf(IDE_REQUEST_HEADING);
		return index === -1
			? undefined
			: trimmed.slice(index + IDE_REQUEST_HEADING.length).trim() || undefined;
	}
	if (INJECTED_USER_PREFIXES.some((prefix) => trimmed.startsWith(prefix)))
		return undefined;
	if (isWholeTagBlock(trimmed)) return undefined;
	return trimmed;
}

function userPromptFromRecord(record: JsonObject): string | undefined {
	const unwrapped = unwrapRecord(record);
	if (unwrapped?.type !== "response_item") return undefined;
	const { payload } = unwrapped;
	if (payload.type !== "message" || payload.role !== "user") return undefined;
	return codexUserPromptText(messageText(payload));
}

const NOISE_TYPES = [
	'"token_usage_record"',
	'"world_state"',
	'"type":"reasoning"',
	'"type":"token_count"',
];

const codexScan: TranscriptScan = {
	mayBeRelevant: (line) => {
		const head = line.slice(0, 240);
		return !NOISE_TYPES.some((noise) => head.includes(noise));
	},
	mayBeCompactionSummary: (line) => line.includes('"type":"compacted"'),
	mayHoldToolActivity: (line) =>
		line.includes("function_call") ||
		line.includes("custom_tool_call") ||
		line.includes("local_shell_call") ||
		line.includes('"item_completed"') ||
		line.includes('"exec_command_end"') ||
		line.includes('"patch_apply_end"'),
	contentChars: (record) =>
		approximateTextChars(
			unwrapRecord(record)?.payload,
			MAX_TOOL_INPUT_CHARS + MAX_TOOL_OUTPUT_CHARS,
		),
	startsUserTurn: (record) => userPromptFromRecord(record) !== undefined,
	isCompactionSummary: (record) =>
		record.type === "compacted" &&
		!!asString(asObject(record.payload)?.message)?.trim(),
};

const CODE_MODE_WRAPPERS = new Set(["exec", "js"]);

/** A code-mode wrapper call (`exec` / `js`) whose real work is reported as items. */
export function isCodeModeWrapper(payload: JsonObject): boolean {
	return (
		(payload.type === "function_call" || payload.type === "custom_tool_call") &&
		CODE_MODE_WRAPPERS.has(asString(payload.name) ?? "")
	);
}

function probeRollout(file: string, test: (text: string) => boolean): boolean {
	if (test(readHeadText(file, ITEM_EVENT_PROBE_BYTES))) return true;
	let scanned = 0;
	for (const line of linesBackward(file, 128 * 1024)) {
		if (test(line)) return true;
		scanned += line.length;
		if (scanned > ITEM_EVENT_PROBE_BYTES) return false;
	}
	return false;
}

/**
 * Whether this rollout is in code mode (0.153+): `exec` / `js` wrapper calls whose
 * shell commands are reported only as CommandExecution items. Earlier builds (0.117+)
 * also write item_completed events, but those repeat a response call with the same id
 * and are merged into it instead.
 */
export function rolloutUsesItemEvents(file: string): boolean {
	return (
		probeRollout(file, (text) => text.includes('"type":"CommandExecution"')) &&
		probeRollout(
			file,
			(text) => text.includes('"name":"exec"') || text.includes('"name":"js"'),
		)
	);
}

/** Folds a completed item into the response call it repeats (same id). */
export function mergeItemIntoCall(call: ToolCall, item: JsonObject): void {
	const fromItem = toolCallFromItem(item);
	if (!fromItem) return;
	if (fromItem.exitCode !== undefined) {
		call.exitCode = fromItem.exitCode;
		call.isError = fromItem.exitCode !== 0;
	} else if (fromItem.isError !== undefined && call.isError === undefined) {
		call.isError = fromItem.isError;
	}
	if (!call.output && fromItem.output) call.output = fromItem.output;
	if (!call.command && fromItem.command) call.command = fromItem.command;
	for (const file of fromItem.changedPaths)
		if (!call.changedPaths.includes(file)) call.changedPaths.push(file);
	for (const file of fromItem.paths)
		if (!call.paths.includes(file)) call.paths.push(file);
}

/** `{"output": "...", "metadata": {"exit_code": 0}}` JSON text, plain text, or content arrays. */
export function parseCallOutput(output: unknown): {
	text: string;
	exitCode?: number;
	success?: boolean;
} {
	if (typeof output === "string") {
		const parsed = output.trimStart().startsWith("{")
			? parseJsonObject(output)
			: undefined;
		if (parsed && ("output" in parsed || "metadata" in parsed)) {
			const text = stringifyValue(parsed.output);
			return {
				text,
				exitCode:
					asNumber(asObject(parsed.metadata)?.exit_code) ??
					exitCodeFromText(text),
			};
		}
		return { text: output, exitCode: exitCodeFromText(output) };
	}
	const object = asObject(output);
	if (object) {
		const text =
			typeof object.content === "string"
				? object.content
				: stringifyValue(object.content ?? object);
		const success =
			typeof object.success === "boolean" ? object.success : undefined;
		return { text, success, exitCode: exitCodeFromText(text) };
	}
	const text = asArray(output)
		.map((item) => asString(asObject(item)?.text) ?? "")
		.filter(Boolean)
		.join("\n");
	return { text };
}

function relativeTo(base: string | undefined, file: string): string {
	return base && !path.isAbsolute(file) ? path.join(base, file) : file;
}

function toolCallFromItem(item: JsonObject): ToolCall | undefined {
	const status = asString(item.status);
	switch (item.type) {
		case "CommandExecution": {
			const argv = asArray(item.command).filter(
				(part): part is string => typeof part === "string",
			);
			const command =
				typeof item.command === "string" ? item.command : commandFromArgv(argv);
			const cwd = asString(item.cwd)
				? fileUrlToPath(asString(item.cwd) as string)
				: undefined;
			const call = createToolCall({
				name: "exec_command",
				input: { command, cwd },
				kind: "shell",
			});
			call.command = command;
			for (const parsed of asArray(item.parsed_cmd)) {
				const parsedPath = asString(asObject(parsed)?.path);
				if (parsedPath) call.paths.push(relativeTo(cwd, parsedPath));
			}
			setToolOutput(
				call,
				item.aggregated_output ?? item.formatted_output ?? item.stdout,
			);
			const exitCode = asNumber(item.exit_code);
			if (exitCode !== undefined) call.exitCode = exitCode;
			call.isError =
				status === "failed" || (exitCode !== undefined && exitCode !== 0);
			return call;
		}
		case "FileChange": {
			const changes = asObject(item.changes) ?? {};
			const paths = Object.keys(changes);
			const allAdded =
				paths.length > 0 &&
				paths.every((file) => asObject(changes[file])?.type === "add");
			const diff = paths
				.map((file) => {
					const change = asObject(changes[file]);
					return `${asString(change?.type) ?? "update"} ${file}\n${asString(change?.unified_diff) ?? asString(change?.content) ?? ""}`;
				})
				.join("\n");
			const call: ToolCall = {
				kind: allAdded ? "write" : "edit",
				name: "apply_patch",
				input: truncateText(diff, MAX_TOOL_INPUT_CHARS),
				paths: [...paths],
				changedPaths: [...paths],
				isError: status !== undefined && status !== "completed",
			};
			setToolOutput(
				call,
				[asString(item.stdout), asString(item.stderr)]
					.filter(Boolean)
					.join("\n"),
			);
			return call;
		}
		case "McpToolCall": {
			const name =
				[asString(item.server), asString(item.tool)]
					.filter(Boolean)
					.join(".") || "mcp_tool";
			const call = createToolCall({
				name,
				input: item.arguments ?? {},
				kind: "other",
			});
			const result = asObject(item.result);
			setToolOutput(call, parseCallOutput(result?.content ?? "").text);
			call.isError = status === "failed" || result?.isError === true;
			return call;
		}
		case "Extension":
			return createToolCall({
				name: asString(item.kind) ?? "extension",
				input: { query: item.query },
				kind: "other",
			});
		case "WebSearch":
			return createToolCall({
				name: "web_search",
				input: { query: item.query },
				kind: "other",
			});
		case "ImageView":
			return createToolCall({
				name: "view_image",
				input: { path: item.path },
				kind: "read",
			});
		default:
			return undefined;
	}
}

function toolCallFromResponseItem(payload: JsonObject): ToolCall | undefined {
	if (payload.type === "function_call") {
		const name = asString(payload.name) ?? "unknown_tool";
		return createToolCall({ name, input: payload.arguments ?? "" });
	}
	if (payload.type === "custom_tool_call") {
		return createToolCall({
			name: asString(payload.name) ?? "unknown_tool",
			input: payload.input ?? "",
		});
	}
	if (payload.type === "local_shell_call") {
		const action = asObject(payload.action);
		const argv = asArray(action?.command).filter(
			(part): part is string => typeof part === "string",
		);
		const call = createToolCall({
			name: "local_shell",
			input: action ?? {},
			kind: "shell",
		});
		call.command = commandFromArgv(argv);
		return call;
	}
	return undefined;
}

function firstPromptInHead(file: string): string | undefined {
	let bytes = 0;
	for (const line of linesForward(file, 128 * 1024)) {
		bytes += line.length;
		if (bytes > 4 * ITEM_EVENT_PROBE_BYTES) return undefined;
		if (!line.includes('"user"')) continue;
		const record = parseJsonObject(line);
		const prompt = record ? userPromptFromRecord(record) : undefined;
		if (prompt) return prompt;
	}
	return undefined;
}

export function readCodexSession(
	ref: SessionRef,
	options: ReaderOptions = {},
): LocalSession {
	const meta = readCodexSessionMeta(ref.location) ?? {};
	const itemMode = rolloutUsesItemEvents(ref.location);
	const assembler = new TurnAssembler(options.activityOnly);
	let model: string | undefined;
	let cwd = meta.cwd ?? ref.cwd;
	let firstPrompt: string | undefined;

	const visit = (record: JsonObject): void => {
		const unwrapped = unwrapRecord(record);
		if (!unwrapped) return;
		const { type, payload } = unwrapped;
		const at = asString(record.timestamp);
		if (type === "turn_context") {
			model = asString(payload.model) ?? model;
			cwd = asString(payload.cwd) ?? cwd;
			return;
		}
		if (type === "compacted") {
			assembler.addCompactionSummary(asString(payload.message) ?? "", at);
			return;
		}
		if (type === "event_msg") {
			if (payload.type === "item_completed") {
				const item = asObject(payload.item);
				if (!item) return;
				const existing = assembler.toolCall(asString(item.id));
				if (existing) {
					mergeItemIntoCall(existing, item);
					assembler.resultApplied(existing);
					return;
				}
				const call = toolCallFromItem(item);
				if (call) {
					assembler.addToolCall(call, asString(item.id), at);
					assembler.resultApplied(call);
				}
				return;
			}
			const call = assembler.toolCall(asString(payload.call_id));
			if (!call) return;
			if (payload.type === "exec_command_end") {
				const exitCode = asNumber(payload.exit_code);
				if (exitCode !== undefined) {
					call.exitCode = exitCode;
					call.isError = exitCode !== 0;
				}
			}
			if (
				payload.type === "patch_apply_end" &&
				typeof payload.success === "boolean"
			) {
				call.isError = !payload.success;
				for (const file of Object.keys(asObject(payload.changes) ?? {})) {
					if (!call.changedPaths.includes(file)) call.changedPaths.push(file);
				}
			}
			return;
		}
		if (type !== "response_item") return;

		if (payload.type === "message") {
			const text = messageText(payload);
			if (payload.role === "assistant") assembler.addAssistantText(text, at);
			if (payload.role === "user") {
				const prompt = codexUserPromptText(text);
				if (prompt) {
					firstPrompt ??= prompt;
					assembler.addUserText(prompt, at);
				}
			}
			return;
		}
		if (itemMode && isCodeModeWrapper(payload)) return;
		const call = toolCallFromResponseItem(payload);
		if (call) {
			assembler.addToolCall(
				call,
				asString(payload.call_id) ?? asString(payload.id),
				at,
			);
			return;
		}
		if (
			payload.type === "function_call_output" ||
			payload.type === "custom_tool_call_output"
		) {
			const target = assembler.toolCall(asString(payload.call_id));
			if (!target) return;
			const output = parseCallOutput(payload.output);
			setToolOutput(target, output.text);
			if (output.exitCode !== undefined && target.exitCode === undefined) {
				target.exitCode = output.exitCode;
				target.isError = output.exitCode !== 0;
			}
			if (output.success !== undefined) target.isError = !output.success;
			assembler.resultApplied(target);
		}
	};
	const { readFromStart, parseErrors } = visitTranscriptRecords(
		ref.location,
		codexScan,
		transcriptReadMode(options),
		visit,
	);

	if (!options.activityOnly && (!readFromStart || !firstPrompt))
		firstPrompt = firstPromptInHead(ref.location) ?? firstPrompt;
	return {
		tool: "codex",
		id: meta.id ?? ref.id,
		cwd,
		gitBranch: meta.gitBranch,
		model,
		startedAt: meta.startedAt,
		updatedAt: ref.updatedAt,
		title: titleFromPrompt(firstPrompt),
		cliVersion: meta.cliVersion,
		turns: assembler.finish(),
		readFromStart,
		unparsedRecords: parseErrors,
	};
}
