/**
 * Grok CLI: `~/.grok/sessions/<encodeURIComponent(cwd)>/<session id>/` with
 * `summary.json` (info.id, info.cwd, generated_title, current_model_id, created_at),
 * `updates.jsonl` (ACP `session/update` notifications) and `chat_history.jsonl`.
 *
 * Shapes handled:
 * - updates.jsonl (agent-hop era and 1.0.x): `params.update.sessionUpdate` of
 *   `user_message_chunk`, `agent_message_chunk` (streamed; concatenated),
 *   `tool_call` (`_meta["x.ai/tool"].name` or `title`, `rawInput`), `tool_call_update`
 *   (`status`, `content[].content.text`, `rawOutput` as text or, in 1.0.x, an object with
 *   `exit_code` / `output`), `session_recap` (kept as a compaction summary placed first).
 *   `agent_thought_chunk`, `hook_execution` and other updates are skipped.
 * - chat_history.jsonl (fallback when updates.jsonl is missing): `user` (text blocks,
 *   `<user_query>` unwrapped, `synthetic_reason` skipped), `assistant` (`content`,
 *   `tool_calls[{id, name, arguments}]`), `tool_result` (`tool_call_id`, `content`).
 * Not verified against a fresh run: the Grok CLI run was not permitted in this environment.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	asArray,
	asNumber,
	asObject,
	asString,
	canonicalPath,
	fileMtimeMs,
	isPathInside,
	type JsonObject,
	listDirectory,
	parseJsonObject,
} from "./io.ts";
import {
	createToolCall,
	MAX_TOOL_INPUT_CHARS,
	MAX_TOOL_OUTPUT_CHARS,
	setToolOutput,
} from "./tool-calls.ts";
import {
	approximateTextChars,
	type TranscriptScan,
	TurnAssembler,
	titleFromPrompt,
	transcriptReadMode,
	visitTranscriptRecords,
} from "./transcript.ts";
import type { LocalSession, ReaderOptions, SessionRef, Turn } from "./types.ts";

export function grokSessionsDirectory(home = os.homedir()): string {
	return path.join(home, ".grok", "sessions");
}

function decodeDirectoryName(name: string): string | undefined {
	try {
		return decodeURIComponent(name);
	} catch {
		return undefined;
	}
}

function sessionUpdatedAt(sessionDirectory: string): number | undefined {
	const times = ["updates.jsonl", "chat_history.jsonl"]
		.map((name) => fileMtimeMs(path.join(sessionDirectory, name)))
		.filter((time): time is number => time !== undefined);
	return times.length > 0 ? Math.max(...times) : undefined;
}

export function discoverGrokSessions(
	repoRoot: string,
	home = os.homedir(),
	limit = 1,
): SessionRef[] {
	const root = canonicalPath(repoRoot);
	const sessionsDirectory = grokSessionsDirectory(home);
	const refs: SessionRef[] = [];
	for (const cwdEntry of listDirectory(sessionsDirectory)) {
		if (!cwdEntry.isDirectory()) continue;
		const cwd = decodeDirectoryName(cwdEntry.name);
		if (
			!cwd ||
			!path.isAbsolute(cwd) ||
			!isPathInside(canonicalPath(cwd), root)
		)
			continue;
		const cwdDirectory = path.join(sessionsDirectory, cwdEntry.name);
		for (const sessionEntry of listDirectory(cwdDirectory)) {
			if (!sessionEntry.isDirectory()) continue;
			const location = path.join(cwdDirectory, sessionEntry.name);
			const updatedAt = sessionUpdatedAt(location);
			if (updatedAt === undefined) continue;
			refs.push({
				tool: "grok",
				id: sessionEntry.name,
				cwd,
				updatedAt,
				location,
			});
		}
	}
	return refs.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}

export function extractUserQuery(text: string): string {
	const match = /<user_query>([\s\S]*?)<\/user_query>/.exec(text);
	return (match?.[1] ?? text).trim();
}

export function updateOf(record: JsonObject): JsonObject | undefined {
	return asObject(asObject(record.params)?.update);
}

const updatesScan: TranscriptScan = {
	mayBeRelevant: (line) =>
		line.includes("_message_chunk") ||
		line.includes('"tool_call') ||
		line.includes('"session_recap"'),
	mayHoldToolActivity: (line) => line.includes('"tool_call'),
	mayBeCompactionSummary: () => false,
	contentChars: (record) => {
		const update = updateOf(record);
		return approximateTextChars(
			[update?.content, update?.rawInput, update?.rawOutput],
			MAX_TOOL_INPUT_CHARS + MAX_TOOL_OUTPUT_CHARS,
		);
	},
	startsUserTurn: (record) =>
		updateOf(record)?.sessionUpdate === "user_message_chunk",
	isCompactionSummary: () => false,
};

const chatHistoryScan: TranscriptScan = {
	mayBeRelevant: (line) =>
		!line.includes('"type":"reasoning"') && !line.includes('"type":"system"'),
	mayHoldToolActivity: (line) =>
		line.includes('"tool_calls"') || line.includes('"tool_result"'),
	mayBeCompactionSummary: () => false,
	contentChars: (record) =>
		approximateTextChars(record, MAX_TOOL_INPUT_CHARS + MAX_TOOL_OUTPUT_CHARS),
	startsUserTurn: (record) =>
		record.type === "user" && record.synthetic_reason === undefined,
	isCompactionSummary: () => false,
};

function applyToolUpdate(assembler: TurnAssembler, update: JsonObject): void {
	const call = assembler.toolCall(asString(update.toolCallId));
	if (!call) return;
	const status = asString(update.status);
	const texts = asArray(update.content)
		.map((item) => asString(asObject(asObject(item)?.content)?.text))
		.filter((text): text is string => !!text);
	const rawOutput = update.rawOutput;
	const rawObject = asObject(rawOutput);
	const output =
		texts.join("\n") ||
		(typeof rawOutput === "string"
			? rawOutput
			: (asString(rawObject?.output_for_prompt) ??
				asString(rawObject?.output)));
	if (output) setToolOutput(call, output);
	const exitCode = asNumber(rawObject?.exit_code);
	if (exitCode !== undefined) call.exitCode = exitCode;
	if (status === "failed") call.isError = true;
	else if (status === "completed")
		call.isError = exitCode !== undefined && exitCode !== 0;
	if (status === "completed" || status === "failed")
		assembler.resultApplied(call);
}

export function readGrokSession(
	ref: SessionRef,
	options: ReaderOptions = {},
): LocalSession {
	const summary = readSummary(ref.location);
	const updatesFile = path.join(ref.location, "updates.jsonl");
	const assembler = new TurnAssembler(options.activityOnly);
	let recap: string | undefined;
	let firstPrompt: string | undefined;
	let result: { readFromStart: boolean; parseErrors: number };

	if (fs.existsSync(updatesFile)) {
		let assistantChunks = "";
		let assistantAt: string | undefined;
		const flushAssistant = () => {
			if (assistantChunks)
				assembler.addAssistantText(assistantChunks, assistantAt);
			assistantChunks = "";
			assistantAt = undefined;
		};
		result = visitTranscriptRecords(
			updatesFile,
			updatesScan,
			transcriptReadMode(options),
			(record) => {
				const update = updateOf(record);
				if (!update) return;
				const at = asString(record.timestamp);
				const kind = asString(update.sessionUpdate);
				if (kind === "agent_message_chunk") {
					assistantChunks += asString(asObject(update.content)?.text) ?? "";
					assistantAt ??= at;
					return;
				}
				flushAssistant();
				if (kind === "user_message_chunk") {
					const text = extractUserQuery(
						asString(asObject(update.content)?.text) ?? "",
					);
					if (text) firstPrompt ??= text;
					assembler.addUserText(text, at);
				} else if (kind === "session_recap") {
					recap = asString(update.summary)?.trim() || recap;
				} else if (kind === "tool_call") {
					const meta = asObject(asObject(update._meta)?.["x.ai/tool"]);
					const name =
						asString(meta?.name) ?? asString(update.title) ?? "unknown_tool";
					const call = createToolCall({ name, input: update.rawInput ?? {} });
					assembler.addToolCall(call, asString(update.toolCallId), at);
				} else if (kind === "tool_call_update") {
					applyToolUpdate(assembler, update);
				}
			},
		);
		flushAssistant();
	} else {
		const chatFile = path.join(ref.location, "chat_history.jsonl");
		result = visitTranscriptRecords(
			chatFile,
			chatHistoryScan,
			transcriptReadMode(options),
			(record) => {
				if (record.type === "user" && record.synthetic_reason === undefined) {
					const text = asArray(record.content)
						.map((block) =>
							extractUserQuery(asString(asObject(block)?.text) ?? ""),
						)
						.join("\n");
					if (text.trim()) firstPrompt ??= text.trim();
					assembler.addUserText(text);
				} else if (record.type === "assistant") {
					assembler.addAssistantText(asString(record.content) ?? "");
					for (const raw of asArray(record.tool_calls)) {
						const toolCall = asObject(raw);
						if (!toolCall) continue;
						const call = createToolCall({
							name: asString(toolCall.name) ?? "unknown_tool",
							input: toolCall.arguments ?? {},
						});
						assembler.addToolCall(call, asString(toolCall.id));
					}
				} else if (record.type === "tool_result") {
					const call = assembler.toolCall(asString(record.tool_call_id));
					if (call) {
						setToolOutput(call, record.content);
						assembler.resultApplied(call);
					}
				}
			},
		);
	}

	const turns: Turn[] = assembler.finish();
	if (recap && !options.activityOnly) {
		turns.unshift({
			role: "user",
			text: recap,
			toolCalls: [],
			synthetic: "compaction-summary",
		});
	}
	const generatedTitle = asString(summary?.generated_title);
	return {
		tool: "grok",
		id: asString(asObject(summary?.info)?.id) ?? ref.id,
		cwd: asString(asObject(summary?.info)?.cwd) ?? ref.cwd,
		model: asString(summary?.current_model_id),
		startedAt: asString(summary?.created_at),
		updatedAt: ref.updatedAt,
		title: generatedTitle || titleFromPrompt(firstPrompt),
		turns,
		readFromStart: result.readFromStart,
		unparsedRecords: result.parseErrors,
	};
}

export function readSummary(sessionDirectory: string): JsonObject | undefined {
	try {
		return parseJsonObject(
			fs.readFileSync(path.join(sessionDirectory, "summary.json"), "utf8"),
		);
	} catch {
		return undefined;
	}
}

export function grokSessionRefForDirectory(
	sessionDirectory: string,
): SessionRef | undefined {
	const summary = readSummary(sessionDirectory);
	const cwd =
		asString(asObject(summary?.info)?.cwd) ??
		decodeDirectoryName(path.basename(path.dirname(sessionDirectory)));
	const updatedAt = sessionUpdatedAt(sessionDirectory);
	if (!cwd || updatedAt === undefined) return undefined;
	return {
		tool: "grok",
		id: path.basename(sessionDirectory),
		cwd,
		updatedAt,
		location: sessionDirectory,
	};
}
