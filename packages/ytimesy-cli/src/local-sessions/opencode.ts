/**
 * OpenCode: SQLite at `$OPENCODE_DB`, else `$XDG_DATA_HOME/opencode/opencode.db`
 * (default `~/.local/share/opencode/opencode.db`), read read-only with the built-in
 * `node:sqlite` (Node 22.5+; without it OpenCode is skipped).
 *
 * Shapes handled:
 * - SQLite (verified on 1.18.25-1.18.32): `session` rows (directory, title, version,
 *   time_updated, optional parent_id / time_archived / model), `message.data` JSON
 *   (`role`, `modelID`, `summary: true` on compaction summaries) and `part.data` JSON
 *   (`text` with optional `synthetic`, `tool` with `state.{status,input,output,error,
 *   metadata.exit}`, `reasoning` dropped, `step-*` / `patch` / `file` skipped).
 *   Bash exit codes come from `state.metadata.exit`.
 * - Legacy JSON storage (pre-SQLite, agent-hop era): `storage/session/<project>/<id>.json`,
 *   `storage/message/<session id>/<id>.json`, `storage/part/<message id>/<id>.json`, with
 *   the same message / part shapes. Used only when the database file does not exist.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
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
import { loadSqlite } from "./sqlite.ts";
import { createToolCall, setToolOutput } from "./tool-calls.ts";
import { TurnAssembler, titleFromPrompt } from "./transcript.ts";
import type { LocalSession, ReaderOptions, SessionRef } from "./types.ts";

const NEW_SESSION_PLACEHOLDER = /^New session - \d{4}-\d{2}-\d{2}/;

export function opencodeDataDirectory(home = os.homedir()): string {
	const xdg = process.env.XDG_DATA_HOME?.trim();
	return path.join(xdg || path.join(home, ".local", "share"), "opencode");
}

export function opencodeDatabasePath(home = os.homedir()): string {
	const override = process.env.OPENCODE_DB?.trim();
	return override || path.join(opencodeDataDirectory(home), "opencode.db");
}

export function openOpencodeDatabase(
	databasePath: string,
): DatabaseSync | undefined {
	if (!fs.existsSync(databasePath)) return undefined;
	const sqlite = loadSqlite();
	if (!sqlite) return undefined;
	try {
		return new sqlite.DatabaseSync(databasePath, { readOnly: true });
	} catch {
		return undefined;
	}
}

function sessionColumns(database: DatabaseSync): Set<string> {
	try {
		return new Set(
			database
				.prepare("PRAGMA table_info(session)")
				.all()
				.map((row) => String(row.name)),
		);
	} catch {
		return new Set();
	}
}

function likePrefix(directory: string): string {
	return `${directory.replace(/[\\%_]/g, (character) => `\\${character}`)}${path.sep}%`;
}

function discoverInDatabase(
	database: DatabaseSync,
	root: string,
	rawRoot: string,
	databasePath: string,
	limit: number,
): SessionRef[] {
	const columns = sessionColumns(database);
	if (!columns.has("directory")) return [];
	const filters = [
		"(directory = ? OR directory LIKE ? ESCAPE '\\' OR directory = ? OR directory LIKE ? ESCAPE '\\')",
	];
	if (columns.has("parent_id")) filters.push("parent_id IS NULL");
	if (columns.has("time_archived")) filters.push("time_archived IS NULL");
	const sql = `SELECT id, directory, time_updated FROM session WHERE ${filters.join(" AND ")} ORDER BY time_updated DESC LIMIT ${Math.max(1, Math.floor(limit))}`;
	try {
		return database
			.prepare(sql)
			.all(root, likePrefix(root), rawRoot, likePrefix(rawRoot))
			.map((row) => ({
				tool: "opencode" as const,
				id: String(row.id),
				cwd: String(row.directory),
				updatedAt: Number(row.time_updated) || 0,
				location: databasePath,
			}));
	} catch {
		return [];
	}
}

function legacyStorageDirectory(home: string): string {
	return path.join(opencodeDataDirectory(home), "storage");
}

function readJsonFile(file: string): JsonObject | undefined {
	try {
		return parseJsonObject(fs.readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

function discoverInLegacyStorage(root: string, home: string): SessionRef[] {
	const sessionsDirectory = path.join(legacyStorageDirectory(home), "session");
	let newest: SessionRef | undefined;
	for (const project of listDirectory(sessionsDirectory)) {
		if (!project.isDirectory()) continue;
		const projectDirectory = path.join(sessionsDirectory, project.name);
		for (const entry of listDirectory(projectDirectory)) {
			if (!entry.name.endsWith(".json")) continue;
			const file = path.join(projectDirectory, entry.name);
			const session = readJsonFile(file);
			const directory = asString(session?.directory);
			if (!session || !directory || asString(session.parentID)) continue;
			if (!isPathInside(canonicalPath(directory), root)) continue;
			const updatedAt =
				asNumber(asObject(session.time)?.updated) ?? fileMtimeMs(file) ?? 0;
			if (!newest || updatedAt > newest.updatedAt) {
				newest = {
					tool: "opencode",
					id: asString(session.id) ?? entry.name.slice(0, -5),
					cwd: directory,
					updatedAt,
					location: file,
				};
			}
		}
	}
	return newest ? [newest] : [];
}

export function discoverOpencodeSessions(
	repoRoot: string,
	home = os.homedir(),
	limit = 1,
): SessionRef[] {
	const root = canonicalPath(repoRoot);
	const databasePath = opencodeDatabasePath(home);
	const database = openOpencodeDatabase(databasePath);
	if (database) {
		try {
			return discoverInDatabase(
				database,
				root,
				path.resolve(repoRoot),
				databasePath,
				limit,
			);
		} finally {
			database.close();
		}
	}
	if (fs.existsSync(databasePath)) return [];
	return discoverInLegacyStorage(root, home);
}

export interface OpencodeMessage {
	data: JsonObject;
	parts: JsonObject[];
	createdAt?: number;
}

class OpencodeTurnBuilder {
	readonly assembler: TurnAssembler;
	model: string | undefined;
	firstPrompt: string | undefined;

	constructor(activityOnly: boolean | undefined) {
		this.assembler = new TurnAssembler(activityOnly);
	}

	add(message: OpencodeMessage): void {
		const at = message.createdAt
			? new Date(message.createdAt).toISOString()
			: undefined;
		const role = asString(message.data.role);
		const texts = message.parts
			.filter(
				(part) =>
					part.type === "text" &&
					part.synthetic !== true &&
					part.ignored !== true,
			)
			.map((part) => asString(part.text) ?? "");
		if (role === "user") {
			if (message.parts.some((part) => part.type === "compaction")) return;
			const text = texts.join("\n");
			if (text.trim()) this.firstPrompt ??= text.trim();
			this.assembler.addUserText(text, at);
			return;
		}
		if (role !== "assistant") return;
		const modelId = asString(message.data.modelID);
		if (modelId)
			this.model = [asString(message.data.providerID), modelId]
				.filter(Boolean)
				.join("/");
		if (message.data.summary === true) {
			this.assembler.addCompactionSummary(texts.join("\n"), at);
			return;
		}
		for (const part of message.parts) {
			if (part.type === "text" && part.synthetic !== true)
				this.assembler.addAssistantText(asString(part.text) ?? "", at);
			if (part.type === "tool") this.addToolPart(part, at);
		}
	}

	private addToolPart(part: JsonObject, at: string | undefined): void {
		const state = asObject(part.state) ?? {};
		const call = createToolCall({
			name: asString(part.tool) ?? "unknown_tool",
			input: state.input ?? {},
		});
		this.assembler.addToolCall(call, asString(part.callID), at);
		const status = asString(state.status);
		setToolOutput(call, state.output ?? state.error);
		const exitCode = asNumber(asObject(state.metadata)?.exit);
		if (exitCode !== undefined) call.exitCode = exitCode;
		if (status === "error") call.isError = true;
		else if (status === "completed")
			call.isError = exitCode !== undefined && exitCode !== 0;
		this.assembler.resultApplied(call);
	}
}

export function* databaseMessages(
	database: DatabaseSync,
	sessionId: string,
	toolPartsOnly: boolean,
): Generator<OpencodeMessage> {
	const partFilter = toolPartsOnly
		? "AND json_extract(p.data, '$.type') = 'tool'"
		: "";
	const statement = database.prepare(
		`SELECT m.id AS message_id, m.data AS message_data, m.time_created AS created, p.data AS part_data
		 FROM message m LEFT JOIN part p ON p.message_id = m.id ${partFilter}
		 WHERE m.session_id = ? ORDER BY m.time_created, m.id, p.id`,
	);
	let current: (OpencodeMessage & { id: string }) | undefined;
	for (const row of statement.iterate(sessionId)) {
		const id = String(row.message_id);
		if (current?.id !== id) {
			if (current) yield current;
			current = {
				id,
				data: parseJsonObject(String(row.message_data)) ?? {},
				parts: [],
				createdAt: Number(row.created) || undefined,
			};
		}
		const part =
			row.part_data === null
				? undefined
				: parseJsonObject(String(row.part_data));
		if (part) current.parts.push(part);
	}
	if (current) yield current;
}

export function* legacyMessages(
	home: string,
	sessionId: string,
): Generator<OpencodeMessage> {
	const storage = legacyStorageDirectory(home);
	const messageDirectory = path.join(storage, "message", sessionId);
	const messageFiles = listDirectory(messageDirectory)
		.filter((entry) => entry.name.endsWith(".json"))
		.map((entry) => entry.name)
		.sort();
	for (const name of messageFiles) {
		const data = readJsonFile(path.join(messageDirectory, name));
		if (!data) continue;
		const messageId = asString(data.id) ?? name.slice(0, -5);
		const partDirectory = path.join(storage, "part", messageId);
		const parts = listDirectory(partDirectory)
			.filter((entry) => entry.name.endsWith(".json"))
			.map((entry) => entry.name)
			.sort()
			.map((partName) => readJsonFile(path.join(partDirectory, partName)))
			.filter((part): part is JsonObject => part !== undefined);
		yield { data, parts, createdAt: asNumber(asObject(data.time)?.created) };
	}
}

interface OpencodeSessionRow {
	title?: string;
	version?: string;
	createdAt?: number;
	model?: string;
}

function sessionRow(
	database: DatabaseSync,
	sessionId: string,
): OpencodeSessionRow {
	try {
		const row = database
			.prepare("SELECT * FROM session WHERE id = ?")
			.get(sessionId);
		if (!row) return {};
		const model = asObject(parseJsonObject(String(row.model ?? "")));
		return {
			title: asString(row.title),
			version: asString(row.version),
			createdAt: asNumber(row.time_created),
			model:
				[asString(model?.providerID), asString(model?.id)]
					.filter(Boolean)
					.join("/") || undefined,
		};
	} catch {
		return {};
	}
}

/** Reads every message of the session; budget trimming is left to trimToBudget (rows are small). */
export function readOpencodeSession(
	ref: SessionRef,
	options: ReaderOptions = {},
	home = os.homedir(),
): LocalSession {
	const builder = new OpencodeTurnBuilder(options.activityOnly);
	let row: OpencodeSessionRow = {};
	if (ref.location.endsWith(".json")) {
		const session = readJsonFile(ref.location);
		row = {
			title: asString(session?.title),
			version: asString(session?.version),
			createdAt: asNumber(asObject(session?.time)?.created),
		};
		for (const message of legacyMessages(home, ref.id)) builder.add(message);
	} else {
		const database = openOpencodeDatabase(ref.location);
		if (database) {
			try {
				row = sessionRow(database, ref.id);
				for (const message of databaseMessages(
					database,
					ref.id,
					options.activityOnly === true,
				))
					builder.add(message);
			} finally {
				database.close();
			}
		}
	}
	const title =
		row.title && !NEW_SESSION_PLACEHOLDER.test(row.title)
			? row.title
			: titleFromPrompt(builder.firstPrompt);
	return {
		tool: "opencode",
		id: ref.id,
		cwd: ref.cwd,
		model: builder.model ?? row.model,
		startedAt: row.createdAt
			? new Date(row.createdAt).toISOString()
			: undefined,
		updatedAt: ref.updatedAt,
		title,
		cliVersion: row.version,
		turns: builder.assembler.finish(),
		readFromStart: true,
		unparsedRecords: 0,
	};
}

/** Every top-level session in the database, for local diagnostics. */
export function listOpencodeSessionRefs(home = os.homedir()): SessionRef[] {
	const databasePath = opencodeDatabasePath(home);
	const database = openOpencodeDatabase(databasePath);
	if (!database) return [];
	try {
		const parentFilter = sessionColumns(database).has("parent_id")
			? "WHERE parent_id IS NULL"
			: "";
		return database
			.prepare(
				`SELECT id, directory, time_updated FROM session ${parentFilter} ORDER BY time_updated DESC`,
			)
			.all()
			.map((row) => ({
				tool: "opencode" as const,
				id: String(row.id),
				cwd: String(row.directory),
				updatedAt: Number(row.time_updated) || 0,
				location: databasePath,
			}));
	} finally {
		database.close();
	}
}
