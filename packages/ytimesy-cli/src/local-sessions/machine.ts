/**
 * Machine-wide session discovery: every session of every supported tool in every
 * folder, with its title, size, an estimated message count and the git identity of its
 * folder. Uses directory listings, file heads (and Claude's last 64 KB for titles) and
 * SQLite metadata queries only; no transcript is read in full.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
	claudeProjectsDirectory,
	claudeSessionRefForFile,
	humanPromptText,
} from "./claude.ts";
import {
	codexSessionRefForFile,
	codexSessionsDirectory,
	codexUserPromptText,
	listCodexRolloutFiles,
	messageText,
	unwrapRecord,
} from "./codex.ts";
import {
	cursorAgentMessageCount,
	cursorChatsDirectory,
	listCursorAgentSessionRefs,
} from "./cursor-agent.ts";
import {
	cursorUserDirectories,
	isListedComposer,
	listCursorComposers,
} from "./cursor-app.ts";
import { listGeminiSessionRefs } from "./gemini.ts";
import { gitIdentity } from "./git.ts";
import {
	grokSessionRefForDirectory,
	grokSessionsDirectory,
	readSummary,
} from "./grok.ts";
import {
	asObject,
	asString,
	canonicalPath,
	isCompressedFile,
	type JsonObject,
	linesBackward,
	listDirectory,
	parseJsonObject,
	readCompressedHead,
	readHeadText,
} from "./io.ts";
import { opencodeDatabasePath, openOpencodeDatabase } from "./opencode.ts";
import { piSessionRefForFile, piSessionsDirectory, textBlocks } from "./pi.ts";
import { SQLITE_MIN_NODE, sqliteAvailable } from "./sqlite.ts";
import { titleFromPrompt } from "./transcript.ts";
import { AGENT_TOOLS, type AgentTool, type SessionRef } from "./types.ts";

const HEAD_BYTES = 256 * 1024;
const TITLE_TAIL_BYTES = 64 * 1024;

export interface FolderGit {
	root: string;
	/** `owner/name` for GitHub, `host/path` otherwise. */
	remote?: string;
	remoteUrl?: string;
	branch?: string;
}

export interface MachineSession {
	tool: AgentTool;
	id: string;
	/** Folder the session ran in; empty when the store does not record it. */
	cwd: string;
	title?: string;
	updatedAt: number;
	/** User + assistant messages; exact when `messageCountExact`, else scaled from the head. */
	messageCount: number;
	messageCountExact: boolean;
	sizeBytes: number;
	/** False when sizeBytes is estimated (Cursor app bubbles are not measured). */
	sizeExact: boolean;
	git: FolderGit | "none";
	/** Enough to read the session with readSession. */
	ref: SessionRef;
}

export interface MachineDiscovery {
	sessions: MachineSession[];
	/** Wall time per tool (plus `git` for folder identities), in ms. */
	timingsMs: Record<string, number>;
	totalMs: number;
	/** Tools whose store could not be read, with the reason. */
	errors: Partial<Record<AgentTool, string>>;
	/** Tools with sessions on this machine that this Node cannot read (no node:sqlite). */
	needsNewerNode: AgentTool[];
}

export interface MachineDiscoveryOptions {
	home?: string;
	tools?: readonly AgentTool[];
	/** Whether node:sqlite works here (default: detected); tests pin it. */
	sqlite?: boolean;
}

/** The SQLite-backed stores that exist on this machine, by tool. */
export function sqliteStoresPresent(home: string): AgentTool[] {
	const present: AgentTool[] = [];
	if (fs.existsSync(opencodeDatabasePath(home))) present.push("opencode");
	if (cursorUserDirectories(home).length) present.push("cursor");
	if (fs.existsSync(cursorChatsDirectory(home))) present.push("cursor-agent");
	return present;
}

/** One line saying which agents' sessions were left out, or null. */
export function sqliteWarning(
	tools: readonly AgentTool[],
	nodeVersion: string = process.versions.node,
) {
	if (!tools.length) return null;
	const names = [
		...new Set(
			tools.map((tool) =>
				tool === "opencode"
					? "OpenCode"
					: tool.startsWith("cursor")
						? "Cursor"
						: tool,
			),
		),
	];
	return `Warning: ${names.join(" and ")} sessions were skipped: reading them needs Node ${SQLITE_MIN_NODE} or newer (this is Node ${nodeVersion}).`;
}

function fileSize(file: string): number {
	try {
		return fs.statSync(file).size;
	} catch {
		return 0;
	}
}

interface HeadSample {
	lines: string[];
	/** Fraction of the file the complete head lines cover (1 when the whole file was read). */
	coverage: number;
}

function headSample(file: string, size: number): HeadSample {
	if (isCompressedFile(file)) {
		const { text, compressedRead } = readCompressedHead(file, HEAD_BYTES / 4);
		const whole = compressedRead >= size;
		const lines = text.split("\n");
		if (!whole) lines.pop();
		const kept = lines.filter((line) => line.trim().length > 0);
		if (whole) return { lines: kept, coverage: 1 };
		const keptBytes = kept.reduce(
			(sum, line) => sum + Buffer.byteLength(line) + 1,
			0,
		);
		const textBytes = Math.max(Buffer.byteLength(text), 1);
		const coverage =
			(keptBytes / textBytes) * (compressedRead / Math.max(size, 1));
		return { lines: kept, coverage: Math.max(coverage, 1e-6) };
	}
	const text = readHeadText(file, HEAD_BYTES);
	const whole = Buffer.byteLength(text) >= size;
	const lines = text.split("\n");
	if (!whole) lines.pop();
	const kept = lines.filter((line) => line.trim().length > 0);
	if (whole) return { lines: kept, coverage: 1 };
	const keptBytes = kept.reduce(
		(sum, line) => sum + Buffer.byteLength(line) + 1,
		0,
	);
	return {
		lines: kept,
		coverage: Math.max(keptBytes / Math.max(size, 1), 1e-6),
	};
}

function estimate(
	count: number,
	sample: HeadSample,
): { count: number; exact: boolean } {
	if (sample.coverage >= 1) return { count, exact: true };
	return { count: Math.round(count / sample.coverage), exact: false };
}

function gitOf(cwd: string): FolderGit | "none" {
	if (!cwd || !path.isAbsolute(cwd)) return "none";
	const identity = gitIdentity(cwd);
	if (!identity) return "none";
	return {
		root: identity.root,
		remote: identity.remote,
		remoteUrl: identity.remoteUrl,
		branch: identity.branch,
	};
}

type Partial3 = Omit<MachineSession, "git">;

function claudeSessions(home: string): Partial3[] {
	const sessions: Partial3[] = [];
	const projects = claudeProjectsDirectory(home);
	for (const project of listDirectory(projects)) {
		if (!project.isDirectory()) continue;
		const directory = path.join(projects, project.name);
		for (const entry of listDirectory(directory)) {
			if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
			const file = path.join(directory, entry.name);
			const ref = claudeSessionRefForFile(file);
			if (!ref) continue;
			const size = fileSize(file);
			const sample = headSample(file, size);
			let messages = 0;
			let firstPrompt: string | undefined;
			let title: string | undefined;
			const titleOf = (record: JsonObject) =>
				asString(record.customTitle) ??
				asString(record.aiTitle) ??
				(record.type === "summary" ? asString(record.summary) : undefined);
			for (const line of sample.lines) {
				const isMessage =
					line.includes('"type":"user"') || line.includes('"type":"assistant"');
				if (isMessage && !line.includes('"isSidechain":true')) messages++;
				if (line.includes('-title"') || line.includes('"type":"summary"')) {
					const record = parseJsonObject(line);
					if (record) title = titleOf(record) ?? title;
				}
				if (!firstPrompt && line.includes('"type":"user"')) {
					const record = parseJsonObject(line);
					firstPrompt = record ? humanPromptText(record) : undefined;
				}
			}
			if (sample.coverage < 1) {
				let scanned = 0;
				for (const line of linesBackward(file, TITLE_TAIL_BYTES)) {
					scanned += line.length;
					if (line.includes('-title"')) {
						const record = parseJsonObject(line);
						const found = record ? titleOf(record) : undefined;
						if (found) {
							title = found;
							break;
						}
					}
					if (scanned > TITLE_TAIL_BYTES) break;
				}
			}
			const counted = estimate(messages, sample);
			sessions.push({
				tool: "claude",
				id: ref.id,
				cwd: ref.cwd,
				title: title ?? titleFromPrompt(firstPrompt),
				updatedAt: ref.updatedAt,
				messageCount: counted.count,
				messageCountExact: counted.exact,
				sizeBytes: size,
				sizeExact: true,
				ref,
			});
		}
	}
	return sessions;
}

function codexThreadNames(home: string): Map<string, string> {
	const names = new Map<string, string>();
	const index = path.join(
		path.dirname(codexSessionsDirectory(home)),
		"session_index.jsonl",
	);
	let text = "";
	try {
		text = fs.readFileSync(index, "utf8");
	} catch {
		return names;
	}
	for (const line of text.split("\n")) {
		const record = parseJsonObject(line);
		const id = asString(record?.id);
		const name = asString(record?.thread_name)?.trim();
		if (id && name) names.set(id, name);
	}
	return names;
}

function codexSessions(home: string): Partial3[] {
	const names = codexThreadNames(home);
	const sessions: Partial3[] = [];
	for (const { file, mtime } of listCodexRolloutFiles(
		codexSessionsDirectory(home),
	)) {
		const ref = codexSessionRefForFile(file, mtime);
		if (!ref) continue;
		const size = fileSize(file);
		const sample = headSample(file, size);
		let messages = 0;
		let firstPrompt: string | undefined;
		for (const line of sample.lines) {
			if (!line.includes('"type":"message"')) continue;
			const record = parseJsonObject(line);
			const payload = record ? unwrapRecord(record)?.payload : undefined;
			if (!payload) continue;
			if (payload.role === "assistant") messages++;
			if (payload.role === "user") {
				const prompt = codexUserPromptText(messageText(payload));
				if (prompt) {
					messages++;
					firstPrompt ??= prompt;
				}
			}
		}
		const counted = estimate(messages, sample);
		sessions.push({
			tool: "codex",
			id: ref.id,
			cwd: ref.cwd,
			title: names.get(ref.id) ?? titleFromPrompt(firstPrompt),
			updatedAt: ref.updatedAt,
			messageCount: counted.count,
			messageCountExact: counted.exact,
			sizeBytes: size,
			sizeExact: true,
			ref,
		});
	}
	return sessions;
}

function opencodeSessions(home: string): Partial3[] {
	const databasePath = opencodeDatabasePath(home);
	const database = openOpencodeDatabase(databasePath);
	if (!database) return [];
	try {
		const rows = database
			.prepare(
				`SELECT s.id, s.directory, s.title, s.time_updated,
					(SELECT count(*) FROM message m WHERE m.session_id = s.id) AS messages,
					(SELECT coalesce(sum(length(p.data)), 0) FROM part p WHERE p.session_id = s.id) AS bytes
				FROM session s WHERE s.parent_id IS NULL`,
			)
			.all();
		return rows.map((row) => {
			const ref: SessionRef = {
				tool: "opencode",
				id: String(row.id),
				cwd: String(row.directory ?? ""),
				updatedAt: Number(row.time_updated) || 0,
				location: databasePath,
			};
			const title = asString(row.title)?.trim();
			return {
				tool: "opencode" as const,
				id: ref.id,
				cwd: ref.cwd,
				title:
					title && !/^New session - \d{4}-/.test(title) ? title : undefined,
				updatedAt: ref.updatedAt,
				messageCount: Number(row.messages) || 0,
				messageCountExact: true,
				sizeBytes: Number(row.bytes) || 0,
				sizeExact: true,
				ref,
			};
		});
	} catch {
		return [];
	} finally {
		database.close();
	}
}

function jsonlFiles(directory: string, depth: number): string[] {
	const files: string[] = [];
	for (const entry of listDirectory(directory)) {
		const full = path.join(directory, entry.name);
		if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(full);
		else if (entry.isDirectory() && depth > 0)
			files.push(...jsonlFiles(full, depth - 1));
	}
	return files;
}

function piSessions(home: string): Partial3[] {
	const sessions: Partial3[] = [];
	for (const file of jsonlFiles(piSessionsDirectory(home), 1)) {
		const ref = piSessionRefForFile(file);
		if (!ref) continue;
		const size = fileSize(file);
		const sample = headSample(file, size);
		let messages = 0;
		let firstPrompt: string | undefined;
		for (const line of sample.lines) {
			if (!line.includes('"type":"message"')) continue;
			const record = parseJsonObject(line);
			const message = asObject(record?.message);
			if (message?.role !== "user" && message?.role !== "assistant") continue;
			messages++;
			if (message.role === "user")
				firstPrompt ??= textBlocks(message.content).trim() || undefined;
		}
		const counted = estimate(messages, sample);
		sessions.push({
			tool: "pi",
			id: ref.id,
			cwd: ref.cwd,
			title: titleFromPrompt(firstPrompt),
			updatedAt: ref.updatedAt,
			messageCount: counted.count,
			messageCountExact: counted.exact,
			sizeBytes: size,
			sizeExact: true,
			ref,
		});
	}
	return sessions;
}

function grokSessions(home: string): Partial3[] {
	const sessions: Partial3[] = [];
	const root = grokSessionsDirectory(home);
	for (const cwdEntry of listDirectory(root)) {
		if (!cwdEntry.isDirectory()) continue;
		for (const sessionEntry of listDirectory(path.join(root, cwdEntry.name))) {
			if (!sessionEntry.isDirectory()) continue;
			const directory = path.join(root, cwdEntry.name, sessionEntry.name);
			const ref = grokSessionRefForDirectory(directory);
			if (!ref) continue;
			const history = path.join(directory, "chat_history.jsonl");
			const updates = path.join(directory, "updates.jsonl");
			const size = fileSize(history) + fileSize(updates);
			const source = fs.existsSync(history) ? history : updates;
			const sample = headSample(source, fileSize(source));
			let messages = 0;
			let previousKind: string | undefined;
			for (const line of sample.lines) {
				if (source === history) {
					if (
						(line.includes('"type":"user"') &&
							!line.includes("synthetic_reason")) ||
						line.includes('"type":"assistant"')
					)
						messages++;
					continue;
				}
				// updates.jsonl streams chunks: count a message when the chunk kind changes.
				const kind = line.includes("user_message_chunk")
					? "user"
					: line.includes("agent_message_chunk")
						? "assistant"
						: line.includes('"tool_call')
							? "tool"
							: undefined;
				if (kind && kind !== "tool" && kind !== previousKind) messages++;
				if (kind) previousKind = kind;
			}
			const counted = estimate(messages, sample);
			sessions.push({
				tool: "grok",
				id: ref.id,
				cwd: ref.cwd,
				title:
					asString(readSummary(directory)?.generated_title)?.trim() ||
					undefined,
				updatedAt: ref.updatedAt,
				messageCount: counted.count,
				messageCountExact: counted.exact,
				sizeBytes: size,
				sizeExact: true,
				ref,
			});
		}
	}
	return sessions;
}

function geminiSessions(
	home: string,
	candidates: readonly string[],
): Partial3[] {
	return listGeminiSessionRefs(home, candidates).map((ref) => {
		const size = fileSize(ref.location);
		if (path.basename(ref.location) === "logs.json")
			return {
				tool: "gemini" as const,
				id: ref.id,
				cwd: ref.cwd,
				updatedAt: ref.updatedAt,
				messageCount: 0,
				messageCountExact: false,
				sizeBytes: 0,
				sizeExact: false,
				ref,
			};
		const sample = headSample(ref.location, size);
		const ids = new Set<string>();
		let title: string | undefined;
		let firstPrompt: string | undefined;
		for (const line of sample.lines) {
			if (line.includes('"$rewindTo"')) {
				const target = asString(parseJsonObject(line)?.$rewindTo);
				let found = false;
				for (const id of [...ids]) {
					if (id === target) found = true;
					if (found) ids.delete(id);
				}
				continue;
			}
			if (line.includes('"$set"') && line.includes('"summary"'))
				title =
					asString(asObject(parseJsonObject(line)?.$set)?.summary) ?? title;
			if (!line.includes('"type":"user"') && !line.includes('"type":"gemini"'))
				continue;
			const record = parseJsonObject(line);
			const id = asString(record?.id);
			if (!record || !id) continue;
			ids.add(id);
			if (!firstPrompt && record.type === "user") {
				const content = record.displayContent ?? record.content;
				firstPrompt =
					typeof content === "string"
						? content
						: (Array.isArray(content) ? content : [])
								.map((part) => asString(asObject(part)?.text) ?? "")
								.join("");
			}
		}
		const counted = estimate(ids.size, sample);
		return {
			tool: "gemini" as const,
			id: ref.id,
			cwd: ref.cwd,
			title: title ?? titleFromPrompt(firstPrompt?.trim() || undefined),
			updatedAt: ref.updatedAt,
			messageCount: counted.count,
			messageCountExact: counted.exact,
			sizeBytes: size,
			sizeExact: true,
			ref,
		};
	});
}

function cursorAgentSessions(
	home: string,
	candidates: readonly string[],
): Partial3[] {
	return listCursorAgentSessionRefs(home, candidates).map((ref) => {
		let title: string | undefined;
		try {
			const meta = parseJsonObject(
				fs.readFileSync(path.join(ref.location, "meta.json"), "utf8"),
			);
			title = asString(meta?.title)?.trim() || undefined;
		} catch {
			title = undefined;
		}
		const count = cursorAgentMessageCount(ref.location);
		return {
			tool: "cursor-agent" as const,
			id: ref.id,
			cwd: ref.cwd,
			title,
			updatedAt: ref.updatedAt,
			messageCount: count ?? 0,
			messageCountExact: count !== undefined,
			sizeBytes: fileSize(path.join(ref.location, "store.db")),
			sizeExact: true,
			ref,
		};
	});
}

/**
 * Average bytes per bubble row, measured on a 1.5 GB Cursor store (228k bubbles).
 * Summing the real bubble sizes reads every overflow page (seconds), so it is estimated.
 */
const CURSOR_AVERAGE_BUBBLE_BYTES = 6800;

function cursorAppSessions(home: string): Partial3[] {
	const sessions: Partial3[] = [];
	for (const userDirectory of cursorUserDirectories(home)) {
		const stateFile = path.join(userDirectory, "globalStorage", "state.vscdb");
		for (const composer of listCursorComposers(userDirectory).composers) {
			if (!isListedComposer(composer)) continue;
			const ref: SessionRef = {
				tool: "cursor",
				id: composer.composerId,
				cwd: composer.folder ?? "",
				updatedAt: composer.updatedAt ?? 0,
				location: stateFile,
			};
			sessions.push({
				tool: "cursor",
				id: ref.id,
				cwd: ref.cwd,
				title: composer.name,
				updatedAt: ref.updatedAt,
				messageCount: composer.messageCount,
				messageCountExact: true,
				sizeBytes:
					composer.sizeBytes +
					composer.messageCount * CURSOR_AVERAGE_BUBBLE_BYTES,
				sizeExact: false,
				ref,
			});
		}
	}
	return sessions;
}

/**
 * Every session of every tool across all folders, newest first, each with its folder's
 * git identity (repo root, normalized `origin`, branch) or `"none"`.
 */
export function discoverAllSessions(
	options: MachineDiscoveryOptions = {},
): MachineDiscovery {
	const home = options.home ?? os.homedir();
	const tools = options.tools ?? AGENT_TOOLS;
	const started = performance.now();
	const timingsMs: Record<string, number> = {};
	const errors: Partial<Record<AgentTool, string>> = {};
	const collected: Partial3[] = [];
	const sqlite = options.sqlite ?? sqliteAvailable();
	const needsNewerNode = sqlite
		? []
		: sqliteStoresPresent(home).filter((tool) => tools.includes(tool));
	const run = (tool: AgentTool, list: () => Partial3[]) => {
		if (!tools.includes(tool)) return;
		if (needsNewerNode.includes(tool)) {
			errors[tool] = `needs Node ${SQLITE_MIN_NODE} or newer`;
			return;
		}
		const start = performance.now();
		try {
			collected.push(...list());
		} catch (error) {
			errors[tool] = error instanceof Error ? error.message : String(error);
		}
		timingsMs[tool] = Math.round((performance.now() - start) * 10) / 10;
	};
	run("claude", () => claudeSessions(home));
	run("codex", () => codexSessions(home));
	run("opencode", () => opencodeSessions(home));
	run("pi", () => piSessions(home));
	run("grok", () => grokSessions(home));
	run("cursor", () => cursorAppSessions(home));
	// Folders other tools recorded resolve Gemini's legacy hash folders and old CLI chats.
	const knownFolders = [
		...new Set(collected.map((session) => session.cwd).filter(Boolean)),
	];
	run("gemini", () => geminiSessions(home, knownFolders));
	run("cursor-agent", () => cursorAgentSessions(home, knownFolders));

	const gitStart = performance.now();
	const gitByCwd = new Map<string, FolderGit | "none">();
	const sessions: MachineSession[] = collected.map((session) => {
		const key = session.cwd ? canonicalPath(session.cwd) : "";
		let git = gitByCwd.get(key);
		if (git === undefined) {
			git = gitOf(key);
			gitByCwd.set(key, git);
		}
		return { ...session, git };
	});
	timingsMs.git = Math.round((performance.now() - gitStart) * 10) / 10;
	return {
		sessions: sessions.sort((a, b) => b.updatedAt - a.updatedAt),
		timingsMs,
		totalMs: Math.round((performance.now() - started) * 10) / 10,
		errors,
		needsNewerNode,
	};
}
