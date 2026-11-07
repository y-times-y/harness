/**
 * Gemini CLI: `<gemini home>/tmp/<project id>/chats/session-<time>-<id8>.jsonl`, where the
 * gemini home is `$GEMINI_CLI_HOME/.gemini` (default `~/.gemini`).
 *
 * Project folders (verified against the 0.40.1 bundle):
 * - Current: `<project id>` is a slug claimed in `projects.json`
 *   (`{projects: {<normalized path>: <slug>}}`; the path is lowercased on macOS and
 *   Windows) and the folder holds a `.project_root` file with the real path.
 * - Older: `<project id>` is sha256 of the project root path; the CLI migrates these to
 *   slugs on start, but old copies can remain. Mapped by hashing candidate paths.
 * Every session file also records `projectHash` = sha256(project root).
 *
 * Session shapes handled:
 * - JSONL (0.3x-0.40): first line `{sessionId, projectHash, startTime, lastUpdated, kind}`;
 *   then message records `{id, timestamp, type: user|gemini|info|error|warning, content,
 *   displayContent?, model?, thoughts?, toolCalls?}` that are re-appended whole when they
 *   change (last copy wins, first position kept), `{$set: {...}}` metadata updates
 *   (`summary` is the generated title) and `{$rewindTo: <message id>}` (drops that message
 *   and everything after it). Tool calls carry `{id, name, args, result: Part[]
 *   (functionResponse.response.output | error), status, resultDisplay}`; shell output
 *   has `Exit Code: N` only when N is non-zero (0.40), or always (older builds).
 *   `kind: "subagent"` files live in `chats/<parent id>/` and are not sessions.
 * - Legacy JSON (pre-JSONL): `session-*.json` holding `{sessionId, projectHash,
 *   startTime, lastUpdated, messages: [...], summary?}` with the same message shape.
 * - `/chat save` checkpoints: `checkpoint-<tag>.json` in the project folder, a Gemini
 *   API history (`Content[]` of `{role: user|model, parts}` with text, functionCall and
 *   functionResponse parts), or `{history: Content[]}` in newer builds. Read on request;
 *   not returned by discovery, since they copy a session that is listed anyway.
 * - `logs.json`: `[{sessionId, messageId, type: "user", message, timestamp}]`, the
 *   prompt log. Used only for sessions that have no chat file (builds before chat
 *   recording); such sessions have user turns only.
 * Compression is recorded only as an `info` notice without the summary text, so Gemini
 * sessions have no compaction summary. No CLI version is recorded.
 * Not verified against a fresh run: no Gemini login or API key is configured here.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { firstUserText, type SessionEvent, turnsFromEvents } from "./events.ts";
import {
	asArray,
	asObject,
	asString,
	canonicalPath,
	fileMtimeMs,
	isPathInside,
	type JsonObject,
	linesForward,
	listDirectory,
	parseJsonObject,
	readFirstLine,
	readHeadText,
} from "./io.ts";
import { exitCodeFromText, stringifyValue } from "./tool-calls.ts";
import { titleFromPrompt } from "./transcript.ts";
import type { LocalSession, ReaderOptions, SessionRef } from "./types.ts";

const SHELL_TOOL = "run_shell_command";

export function geminiDirectory(home = os.homedir()): string {
	const override = process.env.GEMINI_CLI_HOME?.trim();
	return path.join(override || home, ".gemini");
}

export function geminiTempDirectory(home = os.homedir()): string {
	return path.join(geminiDirectory(home), "tmp");
}

export function geminiProjectHash(projectRoot: string): string {
	return crypto.createHash("sha256").update(projectRoot).digest("hex");
}

export interface GeminiProject {
	/** Folder name under tmp/: a slug, or a legacy sha256 hash. */
	id: string;
	directory: string;
	/** Project root; undefined when a legacy hash folder matches no known path. */
	cwd?: string;
}

function readText(file: string): string | undefined {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

function registeredProjects(home: string): Map<string, string> {
	const registry = parseJsonObject(
		readText(path.join(geminiDirectory(home), "projects.json")) ?? "",
	);
	const bySlug = new Map<string, string>();
	for (const [projectPath, slug] of Object.entries(
		asObject(registry?.projects) ?? {},
	))
		if (typeof slug === "string") bySlug.set(slug, projectPath);
	return bySlug;
}

/**
 * Project folders with their roots. `candidates` are extra paths tried against
 * legacy hash folders (the registry's own paths are always tried).
 */
export function listGeminiProjects(
	home = os.homedir(),
	candidates: readonly string[] = [],
): GeminiProject[] {
	const temp = geminiTempDirectory(home);
	const bySlug = registeredProjects(home);
	let byHash: Map<string, string> | undefined;
	const hashLookup = (hash: string): string | undefined => {
		if (!byHash) {
			byHash = new Map();
			for (const candidate of [...bySlug.values(), ...candidates]) {
				for (const variant of new Set([
					candidate,
					path.resolve(candidate),
					canonicalPath(candidate),
				]))
					byHash.set(geminiProjectHash(variant), canonicalPath(variant));
			}
		}
		return byHash.get(hash);
	};
	const projects: GeminiProject[] = [];
	for (const entry of listDirectory(temp)) {
		if (!entry.isDirectory() || entry.name === "bin") continue;
		const directory = path.join(temp, entry.name);
		const marker = readText(path.join(directory, ".project_root"))?.trim();
		const registered = bySlug.get(entry.name);
		let cwd = marker || (registered ? canonicalPath(registered) : undefined);
		if (!cwd && /^[0-9a-f]{64}$/.test(entry.name)) cwd = hashLookup(entry.name);
		projects.push({ id: entry.name, directory, cwd });
	}
	return projects;
}

export interface GeminiSessionHead {
	sessionId?: string;
	projectHash?: string;
	startTime?: string;
	kind?: string;
}

/** Metadata from the first line (JSONL) or the first few KB (legacy JSON). */
export function readGeminiSessionHead(
	file: string,
): GeminiSessionHead | undefined {
	if (file.endsWith(".jsonl")) {
		const first = parseJsonObject(readFirstLine(file) ?? "");
		if (!first) return undefined;
		return {
			sessionId: asString(first.sessionId),
			projectHash: asString(first.projectHash),
			startTime: asString(first.startTime),
			kind: asString(first.kind),
		};
	}
	const head = readHeadText(file, 8 * 1024);
	const field = (name: string) =>
		new RegExp(`"${name}"\\s*:\\s*"([^"]*)"`).exec(head)?.[1];
	return {
		sessionId: field("sessionId"),
		projectHash: field("projectHash"),
		startTime: field("startTime"),
		kind: field("kind"),
	};
}

function sessionFiles(project: GeminiProject): string[] {
	const chats = path.join(project.directory, "chats");
	return listDirectory(chats)
		.filter(
			(entry) =>
				entry.isFile() &&
				entry.name.startsWith("session-") &&
				(entry.name.endsWith(".jsonl") || entry.name.endsWith(".json")),
		)
		.map((entry) => path.join(chats, entry.name));
}

export function geminiSessionRefForFile(
	file: string,
	cwd: string,
): SessionRef | undefined {
	const head = readGeminiSessionHead(file);
	if (!head || head.kind === "subagent") return undefined;
	return {
		tool: "gemini",
		id:
			head.sessionId ?? path.basename(file).replace(/^session-|\.jsonl?$/g, ""),
		cwd,
		updatedAt: fileMtimeMs(file) ?? 0,
		location: file,
	};
}

/** Prompt-log sessions (no chat file): one ref per session id found only in logs.json. */
function promptLogRefs(project: GeminiProject, cwd: string): SessionRef[] {
	const logFile = path.join(project.directory, "logs.json");
	if (!fs.existsSync(logFile)) return [];
	let entries: unknown[];
	try {
		entries = asArray(JSON.parse(readText(logFile) ?? "[]"));
	} catch {
		return [];
	}
	const recorded = new Set(
		sessionFiles(project).map((file) =>
			path
				.basename(file)
				.replace(/\.jsonl?$/, "")
				.slice(-8),
		),
	);
	const latest = new Map<string, number>();
	for (const raw of entries) {
		const entry = asObject(raw);
		const id = asString(entry?.sessionId);
		if (!id || recorded.has(id.slice(0, 8))) continue;
		const at = Date.parse(asString(entry?.timestamp) ?? "") || 0;
		latest.set(id, Math.max(latest.get(id) ?? 0, at));
	}
	return [...latest].map(([id, at]) => ({
		tool: "gemini" as const,
		id,
		cwd,
		updatedAt: at || (fileMtimeMs(logFile) ?? 0),
		location: logFile,
	}));
}

/** Every Gemini session on disk (chat files and prompt-log-only sessions). */
export function listGeminiSessionRefs(
	home = os.homedir(),
	candidates: readonly string[] = [],
): SessionRef[] {
	const refs: SessionRef[] = [];
	for (const project of listGeminiProjects(home, candidates)) {
		const cwd = project.cwd ?? "";
		for (const file of sessionFiles(project)) {
			const ref = geminiSessionRefForFile(file, cwd);
			if (ref) refs.push(ref);
		}
		refs.push(...promptLogRefs(project, cwd));
	}
	return refs.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function discoverGeminiSessions(
	repoRoot: string,
	home = os.homedir(),
	limit = 1,
): SessionRef[] {
	const root = canonicalPath(repoRoot);
	const refs: SessionRef[] = [];
	for (const project of listGeminiProjects(home, [repoRoot, root])) {
		if (!project.cwd || !isPathInside(canonicalPath(project.cwd), root))
			continue;
		for (const file of sessionFiles(project)) {
			const ref = geminiSessionRefForFile(file, project.cwd);
			if (ref) refs.push(ref);
		}
		refs.push(...promptLogRefs(project, project.cwd));
	}
	return refs.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}

function partsText(value: unknown): string {
	if (typeof value === "string") return value;
	const parts = Array.isArray(value) ? value : [value];
	return parts
		.map((part) => {
			const object = asObject(part);
			return object && object.thought !== true ? asString(object.text) : "";
		})
		.filter(Boolean)
		.join("");
}

/** Output text of a tool call's recorded result (`Part[]` of functionResponse). */
function toolResultText(call: JsonObject): string {
	const texts: string[] = [];
	for (const part of asArray(call.result)) {
		const object = asObject(part);
		const response = asObject(asObject(object?.functionResponse)?.response);
		if (response) {
			const output = response.output ?? response.error ?? response.content;
			texts.push(
				typeof output === "string"
					? output
					: stringifyValue(output ?? response),
			);
		} else if (asString(object?.text)) {
			texts.push(asString(object?.text) as string);
		}
	}
	if (texts.length > 0) return texts.join("\n");
	const display = call.resultDisplay;
	return typeof display === "string" ? display : "";
}

/** `Exit Code: N` when printed; 0.40 prints it only for non-zero, so a clean `Output:` result is 0. */
export function geminiShellExitCode(
	output: string,
	status: string | undefined,
): number | undefined {
	const printed = exitCodeFromText(output);
	if (printed !== undefined) return printed;
	if (
		status === "success" &&
		/^Output: /.test(output) &&
		!/^(?:Exit Code|Signal): /m.test(output)
	)
		return 0;
	return undefined;
}

function* messageEvents(message: JsonObject): Generator<SessionEvent> {
	const at = asString(message.timestamp);
	if (message.type === "user") {
		const text =
			partsText(message.displayContent).trim() ||
			partsText(message.content).trim();
		if (text) yield { type: "message", role: "user", text, at };
		return;
	}
	if (message.type !== "gemini") return;
	for (const thought of asArray(message.thoughts)) {
		const object = asObject(thought);
		const text = [asString(object?.subject), asString(object?.description)]
			.filter(Boolean)
			.join(": ");
		if (text) yield { type: "thinking", text, at: asString(object?.timestamp) };
	}
	const text = partsText(message.content).trim();
	if (text) yield { type: "message", role: "assistant", text, at };
	for (const raw of asArray(message.toolCalls)) {
		const call = asObject(raw);
		if (!call) continue;
		const name = asString(call.name) ?? "unknown_tool";
		const callId = asString(call.id);
		const callAt = asString(call.timestamp) ?? at;
		yield {
			type: "tool_call",
			callId,
			name,
			input: call.args ?? {},
			at: callAt,
		};
		const status = asString(call.status);
		if (status === undefined && call.result === undefined) continue;
		const output = toolResultText(call);
		const exitCode =
			name === SHELL_TOOL ? geminiShellExitCode(output, status) : undefined;
		yield {
			type: "tool_result",
			callId,
			output,
			exitCode,
			isError:
				(status !== undefined && status !== "success") ||
				(exitCode !== undefined && exitCode !== 0),
			at: callAt,
		};
	}
}

/** Gemini API history (`/chat save` checkpoints): functionCall / functionResponse parts. */
function* historyEvents(history: unknown[]): Generator<SessionEvent> {
	for (const raw of history) {
		const content = asObject(raw);
		const role = content?.role === "model" ? "assistant" : "user";
		for (const rawPart of asArray(content?.parts)) {
			const part = asObject(rawPart);
			if (!part || part.thought === true) continue;
			const call = asObject(part.functionCall);
			const response = asObject(part.functionResponse);
			if (call) {
				yield {
					type: "tool_call",
					callId: asString(call.id),
					name: asString(call.name) ?? "unknown_tool",
					input: call.args ?? {},
				};
			} else if (response) {
				const body = asObject(response.response);
				const output = body?.output ?? body?.error ?? body;
				const text =
					typeof output === "string" ? output : stringifyValue(output);
				yield {
					type: "tool_result",
					callId: asString(response.id),
					output: text,
					exitCode:
						asString(response.name) === SHELL_TOOL
							? geminiShellExitCode(text, "success")
							: undefined,
					isError: body?.error !== undefined,
				};
			} else if (asString(part.text)?.trim()) {
				yield {
					type: "message",
					role,
					text: (asString(part.text) as string).trim(),
				};
			}
		}
	}
}

export interface GeminiParsed {
	events: SessionEvent[];
	metadata: JsonObject;
	model?: string;
	parseErrors: number;
}

/** Messages of a JSONL session after applying re-appends, `$set` and `$rewindTo`. */
function jsonlMessages(file: string): {
	messages: JsonObject[];
	metadata: JsonObject;
	parseErrors: number;
} {
	const byId = new Map<string, JsonObject>();
	let metadata: JsonObject = {};
	let parseErrors = 0;
	for (const line of linesForward(file)) {
		const record = parseJsonObject(line);
		if (!record) {
			parseErrors++;
			continue;
		}
		if (typeof record.$rewindTo === "string") {
			let found = false;
			for (const id of [...byId.keys()]) {
				if (id === record.$rewindTo) found = true;
				if (found) byId.delete(id);
			}
			if (!found) byId.clear();
		} else if (typeof record.id === "string") {
			byId.set(record.id, record);
		} else if (asObject(record.$set)) {
			metadata = { ...metadata, ...(record.$set as JsonObject) };
		} else if (typeof record.sessionId === "string") {
			metadata = { ...metadata, ...record };
		}
	}
	const inline = asArray(metadata.messages)
		.map((message) => asObject(message))
		.filter((message): message is JsonObject => !!message);
	return {
		messages: inline.length > 0 ? inline : [...byId.values()],
		metadata,
		parseErrors,
	};
}

function readJsonFile(file: string): unknown {
	try {
		return JSON.parse(readText(file) ?? "");
	} catch {
		return undefined;
	}
}

export function parseGeminiSession(ref: SessionRef): GeminiParsed {
	const file = ref.location;
	const base = path.basename(file);
	if (base === "logs.json") {
		const events: SessionEvent[] = [];
		for (const raw of asArray(readJsonFile(file))) {
			const entry = asObject(raw);
			const text = asString(entry?.message)?.trim();
			if (entry?.sessionId !== ref.id || entry.type !== "user" || !text)
				continue;
			events.push({
				type: "message",
				role: "user",
				text,
				at: asString(entry.timestamp),
			});
		}
		return { events, metadata: { sessionId: ref.id }, parseErrors: 0 };
	}
	let messages: JsonObject[] = [];
	let metadata: JsonObject = {};
	let parseErrors = 0;
	if (file.endsWith(".jsonl")) {
		({ messages, metadata, parseErrors } = jsonlMessages(file));
	}
	if (!file.endsWith(".jsonl") || !metadata.sessionId) {
		const whole = readJsonFile(file);
		const history = Array.isArray(whole)
			? whole
			: asArray(asObject(whole)?.history);
		const legacy = asObject(whole);
		if (legacy && Array.isArray(legacy.messages)) {
			metadata = legacy;
			messages = legacy.messages
				.map((message) => asObject(message))
				.filter((message): message is JsonObject => !!message);
			parseErrors = 0;
		} else if (history.length > 0) {
			return { events: [...historyEvents(history)], metadata: {}, parseErrors };
		}
	}
	const events: SessionEvent[] = [];
	let model: string | undefined;
	for (const message of messages) {
		if (message.type === "gemini") model = asString(message.model) ?? model;
		events.push(...messageEvents(message));
	}
	return { events, metadata, model, parseErrors };
}

/**
 * Gemini sessions are rewritten by re-appending whole messages, so the file is read
 * forward in full and `budgetChars` is left to trimToBudget.
 */
export function readGeminiSession(
	ref: SessionRef,
	options: ReaderOptions = {},
): LocalSession {
	const parsed = parseGeminiSession(ref);
	const summary = asString(parsed.metadata.summary)?.trim();
	return {
		tool: "gemini",
		id: asString(parsed.metadata.sessionId) ?? ref.id,
		cwd: ref.cwd,
		model: parsed.model,
		startedAt: asString(parsed.metadata.startTime),
		updatedAt: ref.updatedAt,
		title: summary || titleFromPrompt(firstUserText(parsed.events)),
		turns: turnsFromEvents(parsed.events, options.activityOnly),
		readFromStart: true,
		unparsedRecords: parsed.parseErrors,
	};
}

/** Ref for a `/chat save` checkpoint file (`checkpoint-<tag>.json`). */
export function geminiCheckpointRef(
	file: string,
	cwd: string,
): SessionRef | undefined {
	const match = /^checkpoint-(.+)\.json$/.exec(path.basename(file));
	if (!match) return undefined;
	let tag = match[1] as string;
	try {
		tag = decodeURIComponent(tag);
	} catch {
		// Tags from older builds were written unencoded.
	}
	return {
		tool: "gemini",
		id: `checkpoint:${tag}`,
		cwd,
		updatedAt: fileMtimeMs(file) ?? 0,
		location: file,
	};
}
