/**
 * Cursor CLI (`cursor-agent` / `agent`): `<config>/chats/<md5(path.resolve(cwd))>/<chat id>/`
 * where `<config>` is `$CURSOR_CONFIG_DIR`, else `$XDG_CONFIG_HOME/cursor`, else `~/.cursor`.
 *
 * Shapes handled (verified on 2026.10.01 with fresh sessions):
 * - `meta.json` (schemaVersion 1): `{createdAtMs, updatedAtMs, hasConversation, cwd,
 *   title?, isSubagent?}`. Older chats have no meta.json; their cwd comes from the
 *   conversation root's workspace URI, or from matching the folder hash.
 * - `store.db` (SQLite, read read-only with `node:sqlite`): table `meta` (key `"0"`, value
 *   hex-encoded JSON `{agentId, latestRootBlobId, name, mode, createdAt, ...}`) and table
 *   `blobs (id, data)` holding the blob store described in cursor-blobs.ts.
 * A store that does not have this shape is reported as unsupported, not guessed at.
 * The CLI also writes a lossy copy to `~/.cursor/projects/<slug>/agent-transcripts/`
 * (text and tool inputs, no results); it is not read.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
	blobMessageEvents,
	blobModel,
	decodeConversationRoot,
	parseMessageBlob,
} from "./cursor-blobs.ts";
import { firstUserText, type SessionEvent, turnsFromEvents } from "./events.ts";
import {
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
import { loadSqlite } from "./sqlite.ts";
import { titleFromPrompt } from "./transcript.ts";
import type { LocalSession, ReaderOptions, SessionRef } from "./types.ts";

const PLACEHOLDER_TITLES = new Set(["New Agent", "New Chat", "New chat"]);

export function cursorConfigDirectory(home = os.homedir()): string {
	const override = process.env.CURSOR_CONFIG_DIR?.trim();
	if (override) return override;
	const xdg = process.env.XDG_CONFIG_HOME?.trim();
	return xdg ? path.join(xdg, "cursor") : path.join(home, ".cursor");
}

export function cursorChatsDirectory(home = os.homedir()): string {
	return path.join(cursorConfigDirectory(home), "chats");
}

export function cursorChatFolderHash(cwd: string): string {
	return crypto.createHash("md5").update(path.resolve(cwd)).digest("hex");
}

export function openSqliteReadOnly(file: string): DatabaseSync | undefined {
	if (!fs.existsSync(file)) return undefined;
	const sqlite = loadSqlite();
	if (!sqlite) return undefined;
	try {
		return new sqlite.DatabaseSync(file, { readOnly: true });
	} catch {
		return undefined;
	}
}

interface ChatMeta {
	cwd?: string;
	title?: string;
	createdAtMs?: number;
	updatedAtMs?: number;
	hasConversation?: boolean;
	isSubagent?: boolean;
}

function readChatMeta(chatDirectory: string): ChatMeta | undefined {
	let text: string;
	try {
		text = fs.readFileSync(path.join(chatDirectory, "meta.json"), "utf8");
	} catch {
		return undefined;
	}
	const meta = parseJsonObject(text);
	if (!meta) return undefined;
	return {
		cwd: asString(meta.cwd),
		title: asString(meta.title),
		createdAtMs: asNumber(meta.createdAtMs),
		updatedAtMs: asNumber(meta.updatedAtMs),
		hasConversation:
			typeof meta.hasConversation === "boolean"
				? meta.hasConversation
				: undefined,
		isSubagent: meta.isSubagent === true,
	};
}

/** The `meta` row: hex-encoded JSON in current builds; plain JSON is accepted too. */
export function readStoreMeta(database: DatabaseSync): JsonObject | undefined {
	try {
		const row = database
			.prepare("SELECT value FROM meta WHERE key = ?")
			.get("0");
		const value = row?.value;
		const text =
			typeof value === "string"
				? value
				: value instanceof Uint8Array
					? Buffer.from(value).toString("utf8")
					: undefined;
		if (!text) return undefined;
		if (/^[0-9a-f]+$/i.test(text) && text.length % 2 === 0)
			return parseJsonObject(Buffer.from(text, "hex").toString("utf8"));
		return parseJsonObject(text);
	} catch {
		return undefined;
	}
}

function readBlob(database: DatabaseSync, id: string): Uint8Array | undefined {
	try {
		const row = database.prepare("SELECT data FROM blobs WHERE id = ?").get(id);
		const data = row?.data;
		if (data instanceof Uint8Array) return data;
		if (typeof data === "string") return Buffer.from(data, "utf8");
		return undefined;
	} catch {
		return undefined;
	}
}

/** Workspace cwd from the conversation root, for chats without meta.json. */
function rootWorkspace(storeFile: string): string | undefined {
	const database = openSqliteReadOnly(storeFile);
	if (!database) return undefined;
	try {
		const rootId = asString(readStoreMeta(database)?.latestRootBlobId);
		const root = rootId ? readBlob(database, rootId) : undefined;
		const uri = root
			? decodeConversationRoot(Buffer.from(root))?.workspaceUri
			: undefined;
		return uri?.startsWith("file://") ? fileUrlToPath(uri) : undefined;
	} finally {
		database.close();
	}
}

export function cursorAgentSessionRefForDirectory(
	chatDirectory: string,
	folderCwd?: string,
): SessionRef | undefined {
	const storeFile = path.join(chatDirectory, "store.db");
	const storeMtime = fileMtimeMs(storeFile);
	if (storeMtime === undefined) return undefined;
	const meta = readChatMeta(chatDirectory);
	if (meta?.isSubagent || meta?.hasConversation === false) return undefined;
	const cwd = meta?.cwd ?? folderCwd ?? rootWorkspace(storeFile);
	if (!cwd) return undefined;
	return {
		tool: "cursor-agent",
		id: path.basename(chatDirectory),
		cwd,
		updatedAt: meta?.updatedAtMs ?? storeMtime,
		location: chatDirectory,
	};
}

/** Every CLI chat with a conversation; `candidates` resolve folder hashes for chats without meta.json. */
export function listCursorAgentSessionRefs(
	home = os.homedir(),
	candidates: readonly string[] = [],
): SessionRef[] {
	const byHash = new Map(
		candidates.map((candidate) => [cursorChatFolderHash(candidate), candidate]),
	);
	const chats = cursorChatsDirectory(home);
	const refs: SessionRef[] = [];
	for (const folder of listDirectory(chats)) {
		if (!folder.isDirectory()) continue;
		const folderDirectory = path.join(chats, folder.name);
		for (const chat of listDirectory(folderDirectory)) {
			if (!chat.isDirectory()) continue;
			const ref = cursorAgentSessionRefForDirectory(
				path.join(folderDirectory, chat.name),
				byHash.get(folder.name),
			);
			if (ref) refs.push(ref);
		}
	}
	return refs.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function discoverCursorAgentSessions(
	repoRoot: string,
	home = os.homedir(),
	limit = 1,
): SessionRef[] {
	const root = canonicalPath(repoRoot);
	return listCursorAgentSessionRefs(home, [repoRoot, root])
		.filter((ref) => isPathInside(canonicalPath(ref.cwd), root))
		.slice(0, limit);
}

export interface CursorBlobConversation {
	events: SessionEvent[];
	model?: string;
	unparsed: number;
	unsupported?: string;
	title?: string;
	createdAt?: number;
}

/** Events of a CLI chat; `unsupported` explains a store this reader does not recognize. */
export function cursorAgentConversation(
	chatDirectory: string,
): CursorBlobConversation {
	const database = openSqliteReadOnly(path.join(chatDirectory, "store.db"));
	if (!database)
		return { events: [], unparsed: 0, unsupported: "store.db not readable" };
	try {
		const meta = readStoreMeta(database);
		const rootId = asString(meta?.latestRootBlobId);
		if (!meta || !rootId)
			return {
				events: [],
				unparsed: 0,
				unsupported:
					"unsupported Cursor CLI store: no meta row with latestRootBlobId",
			};
		const rootBlob = readBlob(database, rootId);
		const root = rootBlob
			? decodeConversationRoot(Buffer.from(rootBlob))
			: undefined;
		if (!root)
			return {
				events: [],
				unparsed: 0,
				unsupported:
					"unsupported Cursor CLI store: conversation root not decodable",
			};
		const events: SessionEvent[] = [];
		let model: string | undefined;
		let unparsed = 0;
		for (const id of root.messageIds) {
			const message = parseMessageBlob(readBlob(database, id));
			if (!message) {
				unparsed++;
				continue;
			}
			if (message.role === "system") model = blobModel(message) ?? model;
			events.push(...blobMessageEvents(message));
		}
		const name = asString(meta.name)?.trim();
		return {
			events,
			model: model ?? asString(asObject(meta.lastUsedModel)?.name),
			unparsed,
			title: name && !PLACEHOLDER_TITLES.has(name) ? name : undefined,
			createdAt: asNumber(meta.createdAt),
		};
	} finally {
		database.close();
	}
}

export function readCursorAgentSession(
	ref: SessionRef,
	options: ReaderOptions = {},
): LocalSession {
	const conversation = cursorAgentConversation(ref.location);
	const meta = readChatMeta(ref.location);
	const metaTitle = meta?.title?.trim();
	return {
		tool: "cursor-agent",
		id: ref.id,
		cwd: meta?.cwd ?? ref.cwd,
		model: conversation.model,
		startedAt:
			conversation.createdAt !== undefined
				? new Date(conversation.createdAt).toISOString()
				: meta?.createdAtMs !== undefined
					? new Date(meta.createdAtMs).toISOString()
					: undefined,
		updatedAt: ref.updatedAt,
		title:
			(metaTitle && !PLACEHOLDER_TITLES.has(metaTitle)
				? metaTitle
				: undefined) ??
			conversation.title ??
			titleFromPrompt(firstUserText(conversation.events)),
		turns: turnsFromEvents(conversation.events, options.activityOnly),
		readFromStart: true,
		unparsedRecords: conversation.unparsed,
		unsupported: conversation.unsupported,
	};
}

/** Message count without decoding messages: the root's message ids, system excluded. */
export function cursorAgentMessageCount(
	chatDirectory: string,
): number | undefined {
	const database = openSqliteReadOnly(path.join(chatDirectory, "store.db"));
	if (!database) return undefined;
	try {
		const rootId = asString(readStoreMeta(database)?.latestRootBlobId);
		const root = rootId ? readBlob(database, rootId) : undefined;
		const ids = root
			? decodeConversationRoot(Buffer.from(root))?.messageIds
			: undefined;
		return ids ? Math.max(0, ids.length - 1) : undefined;
	} finally {
		database.close();
	}
}
