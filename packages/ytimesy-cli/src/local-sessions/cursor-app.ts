/**
 * Cursor app (editor agent / composer chats). Private format, read read-only with
 * `node:sqlite` from `<user dir>/globalStorage/state.vscdb`, where `<user dir>` is
 * `~/Library/Application Support/Cursor/User` (macOS), `$XDG_CONFIG_HOME/Cursor/User` or
 * `~/.config/Cursor/User` (Linux), `%APPDATA%\Cursor\User` (Windows).
 *
 * Shapes handled (verified on Cursor 3.28.5 against composer `_v` 3-18 on disk):
 * - Table `cursorDiskKV (key, value)`: `composerData:<composer id>` JSON with `_v`, `name`,
 *   `createdAt`, `lastUpdatedAt`, `modelConfig.modelName`, `workspaceIdentifier.uri.fsPath`
 *   (newer), `subagentInfo` (subagents, skipped), and the conversation in one of:
 *   - `conversation: Bubble[]` inline (no `_v`; the oldest composers);
 *   - `fullConversationHeadersOnly: [{bubbleId, type}]` (`_v` 2+) with each bubble in
 *     `bubbleId:<composer id>:<bubble id>`;
 *   - only `conversationState` (`~` + base64 protobuf root, `_v` 13+ agent chats with no
 *     bubbles), whose message blobs are `agentKv:blob:<hex>` rows (see cursor-blobs.ts).
 *   Bubbles: `type` 1 = user, 2 = assistant; `text`, `createdAt`, `thinking.text`,
 *   `modelInfo.modelName`, `conversationSummary` (string or `{summary}`: the compaction
 *   summary), `toolFormerData {name, params | rawArgs (JSON text), result (JSON text),
 *   status, toolCallId}`. Shell results: `run_terminal_command_v2` records `exitCode`
 *   only when non-zero (zero is the omitted protobuf default), `run_terminal_cmd` records
 *   `exitCodeV2` and `endedReason`; `rejected` means the user declined the command.
 * - Table `composerHeaders (composerId, workspaceId, ...)` (newer builds) and, per
 *   workspace, `workspaceStorage/<id>/workspace.json` (`folder` URI or a `.code-workspace`
 *   file) plus that workspace's `state.vscdb` `ItemTable['composer.composerData']
 *   .allComposers[].composerId`, which map composers to folders.
 * Anything else (no `cursorDiskKV` table, a composer with none of the conversation
 * fields, bubbles that are all missing) is reported as unsupported with the composer
 * version, never guessed at. Pre-composer `aichat` chat tabs (2023) are not read.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openSqliteReadOnly } from "./cursor-agent.ts";
import {
	blobMessageEvents,
	blobModel,
	decodeConversationState,
	parseMessageBlob,
} from "./cursor-blobs.ts";
import { firstUserText, type SessionEvent, turnsFromEvents } from "./events.ts";
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
	listDirectory,
	parseJsonObject,
} from "./io.ts";
import { stringifyValue } from "./tool-calls.ts";
import { titleFromPrompt } from "./transcript.ts";
import type { LocalSession, ReaderOptions, SessionRef } from "./types.ts";

/** Newest composer `_v` seen; newer versions are read only if their shape is recognized. */
export const NEWEST_KNOWN_COMPOSER_VERSION = 18;
const SHELL_TOOLS = new Set(["run_terminal_command_v2", "run_terminal_cmd"]);

/** Cursor's `User` directories that exist, for every platform layout. */
export function cursorUserDirectories(home = os.homedir()): string[] {
	const candidates = [
		path.join(home, "Library", "Application Support", "Cursor", "User"),
		path.join(
			process.env.XDG_CONFIG_HOME?.trim() || path.join(home, ".config"),
			"Cursor",
			"User",
		),
		path.join(
			process.env.APPDATA?.trim() || path.join(home, "AppData", "Roaming"),
			"Cursor",
			"User",
		),
	];
	return [...new Set(candidates)].filter((directory) =>
		fs.existsSync(path.join(directory, "globalStorage", "state.vscdb")),
	);
}

function uriToFolder(uri: string | undefined): string | undefined {
	if (!uri) return undefined;
	if (uri.startsWith("file://")) {
		const folder = fileUrlToPath(uri);
		// file:///c%3A/... on Windows
		return /^\/[a-zA-Z]:/.test(folder) ? folder.slice(1) : folder;
	}
	return undefined;
}

function readJson(file: string): JsonObject | undefined {
	try {
		return parseJsonObject(fs.readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

/** Folder of a workspace: its folder URI, or the first folder of a `.code-workspace` file. */
function workspaceFolder(workspaceJson: JsonObject): string | undefined {
	const folder = uriToFolder(asString(workspaceJson.folder));
	if (folder) return folder;
	const workspaceFile = uriToFolder(asString(workspaceJson.workspace));
	if (!workspaceFile) return undefined;
	const first = asObject(asArray(readJson(workspaceFile)?.folders)[0]);
	const relative = asString(first?.path) ?? uriToFolder(asString(first?.uri));
	return relative
		? path.resolve(path.dirname(workspaceFile), relative)
		: undefined;
}

export interface CursorWorkspace {
	id: string;
	folder?: string;
	stateFile: string;
}

export function listCursorWorkspaces(userDirectory: string): CursorWorkspace[] {
	const storage = path.join(userDirectory, "workspaceStorage");
	const workspaces: CursorWorkspace[] = [];
	for (const entry of listDirectory(storage)) {
		if (!entry.isDirectory()) continue;
		const directory = path.join(storage, entry.name);
		const json = readJson(path.join(directory, "workspace.json"));
		workspaces.push({
			id: entry.name,
			folder: json ? workspaceFolder(json) : undefined,
			stateFile: path.join(directory, "state.vscdb"),
		});
	}
	return workspaces;
}

function workspaceComposerIds(stateFile: string): string[] {
	const database = openSqliteReadOnly(stateFile);
	if (!database) return [];
	try {
		const row = database
			.prepare("SELECT value FROM ItemTable WHERE key = ?")
			.get("composer.composerData");
		const value = row?.value;
		const text =
			typeof value === "string"
				? value
				: value instanceof Uint8Array
					? Buffer.from(value).toString("utf8")
					: "";
		return asArray(parseJsonObject(text)?.allComposers)
			.map((composer) => asString(asObject(composer)?.composerId))
			.filter((id): id is string => !!id);
	} catch {
		return [];
	} finally {
		database.close();
	}
}

function tableNames(database: DatabaseSync): Set<string> {
	try {
		return new Set(
			database
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
				.all()
				.map((row) => String(row.name)),
		);
	} catch {
		return new Set();
	}
}

export interface CursorComposerSummary {
	composerId: string;
	version?: number;
	name?: string;
	createdAt?: number;
	updatedAt?: number;
	/** Bubbles, inline messages, or blob messages (system excluded). */
	messageCount: number;
	folder?: string;
	workspaceId?: string;
	isSubagent: boolean;
	/**
	 * None of the known conversation fields is present (a newer private format); kept
	 * so reading it reports "unsupported Cursor version" instead of hiding it.
	 */
	unrecognized: boolean;
	/** Bytes of the composerData row. */
	sizeBytes: number;
}

const summarySql = (where: string) => `
WITH composer AS (
	SELECT substr(key, 14) AS id, CAST(value AS TEXT) AS json
	FROM cursorDiskKV
	WHERE ${where}
)
SELECT id,
	length(json) AS size,
	json_valid(json) AS valid,
	CASE WHEN json_valid(json) THEN json_extract(json, '$._v') END AS version,
	CASE WHEN json_valid(json) THEN json_extract(json, '$.name') END AS name,
	CASE WHEN json_valid(json) THEN json_extract(json, '$.createdAt') END AS createdAt,
	CASE WHEN json_valid(json) THEN json_extract(json, '$.lastUpdatedAt') END AS lastUpdatedAt,
	CASE WHEN json_valid(json) THEN json_array_length(json, '$.fullConversationHeadersOnly') END AS headers,
	CASE WHEN json_valid(json) THEN json_array_length(json, '$.conversation') END AS inline,
	CASE WHEN json_valid(json) THEN json_extract(json, '$.workspaceIdentifier.uri.fsPath') END AS fsPath,
	CASE WHEN json_valid(json) THEN json_type(json, '$.subagentInfo') END AS subagent,
	CASE WHEN json_valid(json) THEN json_type(json, '$.fullConversationHeadersOnly') IS NULL
		AND json_type(json, '$.conversation') IS NULL
		AND json_type(json, '$.conversationState') IS NULL END AS unrecognized,
	CASE WHEN json_valid(json) AND coalesce(json_array_length(json, '$.fullConversationHeadersOnly'), 0) = 0
		THEN json_extract(json, '$.conversationState') END AS state
FROM composer`;

/**
 * One row per composer from the global store, with its folder. Uses SQLite's JSON
 * functions so the large composer rows are not parsed in JavaScript; bubbles are not read.
 */
export function listCursorComposers(
	userDirectory: string,
	options: { folderFilter?: (folder: string) => boolean } = {},
): {
	composers: CursorComposerSummary[];
	unparsed: number;
	unsupported?: string;
} {
	const database = openSqliteReadOnly(
		path.join(userDirectory, "globalStorage", "state.vscdb"),
	);
	if (!database)
		return {
			composers: [],
			unparsed: 0,
			unsupported: "state.vscdb not readable",
		};
	try {
		const tables = tableNames(database);
		if (!tables.has("cursorDiskKV"))
			return {
				composers: [],
				unparsed: 0,
				unsupported: "unsupported Cursor version: no cursorDiskKV table",
			};
		const workspaces = listCursorWorkspaces(userDirectory);
		const folderOf = new Map(
			workspaces.map((workspace) => [workspace.id, workspace.folder]),
		);
		const headerWorkspace = new Map<string, string>();
		if (tables.has("composerHeaders")) {
			try {
				for (const row of database
					.prepare("SELECT composerId, workspaceId FROM composerHeaders")
					.all())
					if (row.workspaceId)
						headerWorkspace.set(
							String(row.composerId),
							String(row.workspaceId),
						);
			} catch {
				// Older or changed header table: fall back to per-workspace lists.
			}
		}
		const composerWorkspace = new Map<string, string>();
		for (const workspace of workspaces) {
			if (
				options.folderFilter &&
				(!workspace.folder || !options.folderFilter(workspace.folder))
			)
				continue;
			for (const id of workspaceComposerIds(workspace.stateFile))
				composerWorkspace.set(id, workspace.id);
		}
		// With a folder filter, only composers already mapped to a matching workspace are
		// looked up by key; otherwise every composer row is summarized in one scan.
		let rows: Record<string, unknown>[];
		if (options.folderFilter) {
			const candidates = new Set(composerWorkspace.keys());
			for (const [id, workspaceId] of headerWorkspace) {
				const folder = folderOf.get(workspaceId);
				if (folder && options.folderFilter(folder)) candidates.add(id);
			}
			const statement = database.prepare(summarySql("key = ?"));
			rows = [];
			for (const id of candidates) {
				const row = statement.get(`composerData:${id}`);
				if (row) rows.push(row);
			}
		} else {
			rows = database
				.prepare(summarySql("key >= 'composerData:' AND key < 'composerData;'"))
				.all();
		}
		const composers: CursorComposerSummary[] = [];
		let unparsed = 0;
		for (const row of rows) {
			if (!row.valid) {
				unparsed++;
				continue;
			}
			const id = String(row.id);
			const workspaceId = headerWorkspace.get(id) ?? composerWorkspace.get(id);
			const folder =
				asString(row.fsPath) ??
				(workspaceId ? folderOf.get(workspaceId) : undefined);
			if (options.folderFilter && (!folder || !options.folderFilter(folder)))
				continue;
			const stateIds =
				decodeConversationState(asString(row.state))?.messageIds.length ?? 0;
			composers.push({
				composerId: id,
				version: asNumber(row.version),
				name: asString(row.name)?.trim() || undefined,
				createdAt: asNumber(row.createdAt),
				updatedAt: asNumber(row.lastUpdatedAt) ?? asNumber(row.createdAt),
				messageCount:
					Number(row.headers) ||
					Number(row.inline) ||
					Math.max(0, stateIds - 1),
				folder,
				workspaceId,
				isSubagent: row.subagent !== null && row.subagent !== undefined,
				unrecognized: Number(row.unrecognized) === 1,
				sizeBytes: Number(row.size) || 0,
			});
		}
		return { composers, unparsed };
	} catch (error) {
		return {
			composers: [],
			unparsed: 0,
			unsupported: `unsupported Cursor version: ${error instanceof Error ? error.message : String(error)}`,
		};
	} finally {
		database.close();
	}
}

function composerRef(
	userDirectory: string,
	composer: CursorComposerSummary,
): SessionRef {
	const stateFile = path.join(userDirectory, "globalStorage", "state.vscdb");
	return {
		tool: "cursor",
		id: composer.composerId,
		cwd: composer.folder ?? "",
		updatedAt: composer.updatedAt ?? fileMtimeMs(stateFile) ?? 0,
		location: stateFile,
	};
}

export function isListedComposer(composer: CursorComposerSummary): boolean {
	return (
		!composer.isSubagent && (composer.messageCount > 0 || composer.unrecognized)
	);
}

/** Every non-empty (or unrecognized) top-level composer, newest first. */
export function listCursorSessionRefs(home = os.homedir()): SessionRef[] {
	const refs: SessionRef[] = [];
	for (const userDirectory of cursorUserDirectories(home)) {
		for (const composer of listCursorComposers(userDirectory).composers)
			if (isListedComposer(composer))
				refs.push(composerRef(userDirectory, composer));
	}
	return refs.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function discoverCursorSessions(
	repoRoot: string,
	home = os.homedir(),
	limit = 1,
): SessionRef[] {
	const root = canonicalPath(repoRoot);
	const inside = (folder: string) => isPathInside(canonicalPath(folder), root);
	const refs: SessionRef[] = [];
	for (const userDirectory of cursorUserDirectories(home)) {
		for (const composer of listCursorComposers(userDirectory, {
			folderFilter: inside,
		}).composers)
			if (isListedComposer(composer))
				refs.push(composerRef(userDirectory, composer));
	}
	return refs.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}

function valueText(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
	return undefined;
}

function kvJson(database: DatabaseSync, key: string): JsonObject | undefined {
	try {
		const row = database
			.prepare("SELECT value FROM cursorDiskKV WHERE key = ?")
			.get(key);
		return parseJsonObject(valueText(row?.value) ?? "");
	} catch {
		return undefined;
	}
}

function parseJsonText(value: unknown): unknown {
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

function bubbleAt(bubble: JsonObject): string | undefined {
	const created = bubble.createdAt;
	if (typeof created === "string") return created;
	if (typeof created === "number") return new Date(created).toISOString();
	return undefined;
}

/** Events for one tool call recorded in a bubble's `toolFormerData`. */
export function* toolFormerEvents(
	data: JsonObject,
	at: string | undefined,
): Generator<SessionEvent> {
	const name =
		asString(data.name) ??
		(data.tool !== undefined ? `tool_${String(data.tool)}` : "unknown_tool");
	const params =
		asObject(parseJsonText(data.params)) ??
		asObject(parseJsonText(data.rawArgs)) ??
		{};
	const callId = asString(data.toolCallId);
	const isShell = SHELL_TOOLS.has(name);
	yield {
		type: "tool_call",
		callId,
		name,
		input: params,
		kind: isShell ? "shell" : undefined,
		command: isShell ? asString(params.command) : undefined,
		at,
	};
	const status = asString(data.status);
	if (
		data.result === undefined &&
		(status === undefined || status === "loading")
	)
		return;
	const parsed = parseJsonText(data.result);
	const result = asObject(parsed);
	const failed =
		status === "error" || status === "cancelled" || data.error !== undefined;
	if (isShell) {
		const rejected = result?.rejected === true;
		let exitCode = asNumber(result?.exitCode) ?? asNumber(result?.exitCodeV2);
		if (
			exitCode === undefined &&
			name === "run_terminal_command_v2" &&
			status === "completed" &&
			result &&
			!rejected
		)
			exitCode = 0;
		yield {
			type: "tool_result",
			callId,
			output:
				asString(result?.output) ??
				asString(result?.outputRaw) ??
				(typeof parsed === "string" ? parsed : ""),
			exitCode,
			isError: failed || rejected || (exitCode !== undefined && exitCode !== 0),
			at,
		};
		return;
	}
	yield {
		type: "tool_result",
		callId,
		output:
			typeof parsed === "string"
				? parsed
				: stringifyValue(parsed ?? asObject(data.error) ?? ""),
		isError: failed,
		at,
	};
}

/** Events for one bubble (user or assistant message, its tool call, summary). */
export function* bubbleEvents(bubble: JsonObject): Generator<SessionEvent> {
	const at = bubbleAt(bubble);
	const summary = bubble.conversationSummary;
	const summaryText =
		typeof summary === "string"
			? summary
			: asString(asObject(summary)?.summary);
	if (summaryText?.trim())
		yield { type: "compaction", text: summaryText.trim(), at };
	const text = asString(bubble.text)?.trim() ?? "";
	if (bubble.type === 1) {
		if (text) yield { type: "message", role: "user", text, at };
		return;
	}
	const thinking = asString(asObject(bubble.thinking)?.text)?.trim();
	if (thinking) yield { type: "thinking", text: thinking, at };
	if (text) yield { type: "message", role: "assistant", text, at };
	const toolData = asObject(bubble.toolFormerData);
	if (toolData && (toolData.name !== undefined || toolData.tool !== undefined))
		yield* toolFormerEvents(toolData, at);
}

export interface CursorComposerConversation {
	events: SessionEvent[];
	composer?: JsonObject;
	model?: string;
	unparsed: number;
	unsupported?: string;
}

function bubblesFor(
	database: DatabaseSync,
	composerId: string,
	headers: JsonObject[],
): { bubbles: JsonObject[]; unparsed: number; missing: number } {
	const byId = new Map<string, JsonObject>();
	let unparsed = 0;
	const prefix = `bubbleId:${composerId}:`;
	for (const row of database
		.prepare("SELECT key, value FROM cursorDiskKV WHERE key >= ? AND key < ?")
		.iterate(prefix, `bubbleId:${composerId};`)) {
		const bubble = parseJsonObject(valueText(row.value) ?? "");
		if (!bubble) {
			unparsed++;
			continue;
		}
		byId.set(String(row.key).slice(prefix.length), bubble);
	}
	const bubbles: JsonObject[] = [];
	let missing = 0;
	for (const header of headers) {
		const bubble = byId.get(asString(header.bubbleId) ?? "");
		if (bubble) bubbles.push(bubble);
		else missing++;
	}
	return { bubbles, unparsed, missing };
}

/** Events of one composer; `unsupported` names a shape this reader does not recognize. */
export function cursorComposerConversation(
	stateFile: string,
	composerId: string,
): CursorComposerConversation {
	const database = openSqliteReadOnly(stateFile);
	if (!database)
		return { events: [], unparsed: 0, unsupported: "state.vscdb not readable" };
	try {
		if (!tableNames(database).has("cursorDiskKV"))
			return {
				events: [],
				unparsed: 0,
				unsupported: "unsupported Cursor version: no cursorDiskKV table",
			};
		const composer = kvJson(database, `composerData:${composerId}`);
		if (!composer)
			return {
				events: [],
				unparsed: 1,
				unsupported: "composer not found or not JSON",
			};
		const version = asNumber(composer._v);
		const unsupported = (why: string) => ({
			events: [],
			composer,
			unparsed: 0,
			unsupported: `unsupported Cursor version (composer _v=${version ?? "none"}): ${why}`,
		});
		const headers = asArray(composer.fullConversationHeadersOnly)
			.map((header) => asObject(header))
			.filter((header): header is JsonObject => !!header);
		const inline = asArray(composer.conversation)
			.map((bubble) => asObject(bubble))
			.filter((bubble): bubble is JsonObject => !!bubble);
		let bubbles: JsonObject[] | undefined;
		let unparsed = 0;
		if (inline.length > 0) bubbles = inline;
		else if (headers.length > 0) {
			const loaded = bubblesFor(database, composerId, headers);
			if (loaded.bubbles.length === 0)
				return unsupported(`${headers.length} bubbles listed, none found`);
			bubbles = loaded.bubbles;
			unparsed = loaded.unparsed + loaded.missing;
		}
		const events: SessionEvent[] = [];
		let model = asString(asObject(composer.modelConfig)?.modelName);
		if (bubbles) {
			for (const bubble of bubbles) {
				if (bubble.type !== 1 && bubble.type !== 2) {
					unparsed++;
					continue;
				}
				const bubbleModel = asString(asObject(bubble.modelInfo)?.modelName);
				if (bubbleModel && bubbleModel !== "default") model = bubbleModel;
				events.push(...bubbleEvents(bubble));
			}
			return { events, composer, model, unparsed };
		}
		const root = decodeConversationState(asString(composer.conversationState));
		if (root && root.messageIds.length > 0) {
			for (const id of root.messageIds) {
				let data: unknown;
				try {
					data = database
						.prepare("SELECT value FROM cursorDiskKV WHERE key = ?")
						.get(`agentKv:blob:${id}`)?.value;
				} catch {
					data = undefined;
				}
				const message = parseMessageBlob(
					data instanceof Uint8Array || typeof data === "string"
						? data
						: undefined,
				);
				if (!message) {
					unparsed++;
					continue;
				}
				if (message.role === "system") model = blobModel(message) ?? model;
				events.push(...blobMessageEvents(message));
			}
			return { events, composer, model, unparsed };
		}
		const known =
			"fullConversationHeadersOnly" in composer ||
			"conversation" in composer ||
			"conversationState" in composer;
		if (known && (version ?? 0) <= NEWEST_KNOWN_COMPOSER_VERSION)
			return { events: [], composer, model, unparsed: 0 };
		return unsupported("no conversation, bubble headers or conversation state");
	} finally {
		database.close();
	}
}

export function readCursorSession(
	ref: SessionRef,
	options: ReaderOptions = {},
): LocalSession {
	const conversation = cursorComposerConversation(ref.location, ref.id);
	const composer = conversation.composer;
	const createdAt = asNumber(composer?.createdAt);
	const name = asString(composer?.name)?.trim();
	return {
		tool: "cursor",
		id: ref.id,
		cwd:
			asString(
				asObject(asObject(composer?.workspaceIdentifier)?.uri)?.fsPath,
			) ?? ref.cwd,
		model: conversation.model,
		startedAt:
			createdAt !== undefined ? new Date(createdAt).toISOString() : undefined,
		updatedAt: ref.updatedAt,
		title: name || titleFromPrompt(firstUserText(conversation.events)),
		cliVersion:
			asNumber(composer?._v) !== undefined
				? `composer-v${asNumber(composer?._v)}`
				: undefined,
		turns: turnsFromEvents(conversation.events, options.activityOnly),
		readFromStart: true,
		unparsedRecords: conversation.unparsed,
		unsupported: conversation.unsupported,
	};
}
