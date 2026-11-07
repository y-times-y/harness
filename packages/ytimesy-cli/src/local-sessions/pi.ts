/**
 * Pi coding agent: `$PI_CODING_AGENT_DIR/sessions` (default `~/.pi/agent/sessions`),
 * one directory per cwd named `--<cwd without leading slash, "/", "\" and ":" as "-">--`,
 * holding `<timestamp>_<id>.jsonl` files.
 *
 * Shapes handled:
 * - Header `{type: "session", version, id, cwd, timestamp}`; versions 1-3. From version 2
 *   entries carry `id` / `parentId` and form a tree; the current branch is the chain from
 *   the last entry back to the root. Version 1 files are read linearly.
 * - `message` entries: `user` / `assistant` content blocks (`text`, `toolCall {id, name,
 *   arguments}`, `thinking` dropped, flat `image` skipped), `toolResult` messages
 *   (`toolCallId`, `isError`, text content; "Command exited with code N" on failure),
 *   `bashExecution` messages (a `!` command the person ran: command, output, exitCode).
 * - `compaction` entries (`summary`, `firstKeptEntryId`): the summary is placed before
 *   the first kept entry. `model_change` gives the model. Other entry types are skipped.
 * Files are small, so the whole branch is read; budgets are applied by trimToBudget.
 */
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
	linesForward,
	listDirectory,
	parseJsonObject,
	readFirstLine,
} from "./io.ts";
import {
	createToolCall,
	exitCodeFromText,
	setToolOutput,
} from "./tool-calls.ts";
import { TurnAssembler, titleFromPrompt } from "./transcript.ts";
import type { LocalSession, ReaderOptions, SessionRef } from "./types.ts";

const MAX_FILES_VERIFIED_PER_DIRECTORY = 5;
const RELEVANT_ENTRY_TYPES = new Set([
	"session",
	"message",
	"compaction",
	"model_change",
]);

export function piSessionsDirectory(home = os.homedir()): string {
	const agentDirectory = process.env.PI_CODING_AGENT_DIR?.trim();
	return agentDirectory
		? path.join(agentDirectory, "sessions")
		: path.join(home, ".pi", "agent", "sessions");
}

export function encodePiSessionDirectory(cwd: string): string {
	const withoutLeadingSeparator = cwd.replace(/^[/\\]/, "");
	return `--${withoutLeadingSeparator.replace(/[/\\:]/g, "-")}--`;
}

interface PiHeader {
	id?: string;
	cwd?: string;
	timestamp?: string;
	version?: number;
}

export function readPiHeader(file: string): PiHeader | undefined {
	const line = readFirstLine(file);
	const record = line ? parseJsonObject(line) : undefined;
	if (record?.type !== "session") return undefined;
	return {
		id: asString(record.id),
		cwd: asString(record.cwd),
		timestamp: asString(record.timestamp),
		version: asNumber(record.version),
	};
}

export function piSessionRefForFile(file: string): SessionRef | undefined {
	const header = readPiHeader(file);
	if (!header?.cwd) return undefined;
	return {
		tool: "pi",
		id: header.id ?? path.basename(file, ".jsonl"),
		cwd: header.cwd,
		updatedAt: fileMtimeMs(file) ?? 0,
		location: file,
	};
}

export function discoverPiSessions(
	repoRoot: string,
	home = os.homedir(),
	limit = 1,
): SessionRef[] {
	const root = canonicalPath(repoRoot);
	const encodedRoot = encodePiSessionDirectory(root);
	const childPrefix = `${encodedRoot.slice(0, -2)}-`;
	const sessionsDirectory = piSessionsDirectory(home);
	const refs: SessionRef[] = [];
	for (const entry of listDirectory(sessionsDirectory)) {
		if (!entry.isDirectory()) continue;
		if (
			entry.name !== encodedRoot &&
			!(entry.name.startsWith(childPrefix) && entry.name.endsWith("--"))
		)
			continue;
		const directory = path.join(sessionsDirectory, entry.name);
		const files = listDirectory(directory)
			.filter((file) => file.isFile() && file.name.endsWith(".jsonl"))
			.map((file) => path.join(directory, file.name))
			.map((file) => ({ file, mtime: fileMtimeMs(file) ?? 0 }))
			.sort((a, b) => b.mtime - a.mtime)
			.slice(0, Math.max(MAX_FILES_VERIFIED_PER_DIRECTORY, limit));
		let found = 0;
		for (const { file } of files) {
			const ref = piSessionRefForFile(file);
			if (ref && isPathInside(canonicalPath(ref.cwd), root)) {
				refs.push(ref);
				if (++found >= limit) break;
			}
		}
	}
	return refs;
}

/** Entries on the current branch, in order, with the newest compaction moved before its first kept entry. */
export function piBranchEntries(entries: JsonObject[]): JsonObject[] {
	const withIds = entries.filter(
		(entry) => typeof entry.id === "string" && entry.type !== "session",
	);
	let branch: JsonObject[];
	if (withIds.length === 0) {
		branch = entries.filter((entry) => entry.type !== "session");
	} else {
		const byId = new Map(withIds.map((entry) => [entry.id as string, entry]));
		branch = [];
		const visited = new Set<string>();
		let current: JsonObject | undefined = withIds.at(-1);
		while (current && !visited.has(current.id as string)) {
			visited.add(current.id as string);
			branch.push(current);
			const parentId = asString(current.parentId);
			current = parentId ? byId.get(parentId) : undefined;
		}
		branch.reverse();
	}
	let compactionIndex = -1;
	branch.forEach((entry, index) => {
		if (entry.type === "compaction") compactionIndex = index;
	});
	if (compactionIndex === -1) return branch;
	const compaction = branch[compactionIndex] as JsonObject;
	const keptIndex = branch.findIndex(
		(entry) => entry.id === compaction.firstKeptEntryId,
	);
	if (keptIndex === -1 || keptIndex > compactionIndex) return branch;
	const reordered = branch.filter((_, index) => index !== compactionIndex);
	reordered.splice(keptIndex, 0, compaction);
	return reordered;
}

export function textBlocks(content: unknown): string {
	if (typeof content === "string") return content;
	return asArray(content)
		.map((block) => asObject(block))
		.filter((block) => block?.type === "text")
		.map((block) => asString(block?.text) ?? "")
		.join("\n");
}

export function readPiSession(
	ref: SessionRef,
	options: ReaderOptions = {},
): LocalSession {
	const header = readPiHeader(ref.location);
	const entries: JsonObject[] = [];
	let unparsedRecords = 0;
	for (const line of linesForward(ref.location)) {
		const record = parseJsonObject(line);
		if (!record) {
			unparsedRecords++;
			continue;
		}
		if (RELEVANT_ENTRY_TYPES.has(String(record.type))) entries.push(record);
	}

	const assembler = new TurnAssembler(options.activityOnly);
	let model: string | undefined;
	let firstPrompt: string | undefined;
	for (const entry of piBranchEntries(entries)) {
		const at = asString(entry.timestamp);
		if (entry.type === "model_change") {
			model =
				[asString(entry.provider), asString(entry.modelId)]
					.filter(Boolean)
					.join("/") || model;
			continue;
		}
		if (entry.type === "compaction") {
			assembler.addCompactionSummary(asString(entry.summary) ?? "", at);
			continue;
		}
		const message = asObject(entry.message);
		if (!message) continue;
		const role = asString(message.role);
		if (role === "user") {
			const text = textBlocks(message.content).trim();
			if (text) firstPrompt ??= text;
			assembler.addUserText(text, at);
		} else if (role === "assistant") {
			if (
				asString(message.stopReason) === "error" &&
				asArray(message.content).length === 0
			)
				continue;
			model =
				[asString(message.provider), asString(message.model)]
					.filter(Boolean)
					.join("/") || model;
			for (const raw of asArray(message.content)) {
				const block = asObject(raw);
				if (block?.type === "text")
					assembler.addAssistantText(asString(block.text) ?? "", at);
				if (block?.type === "toolCall") {
					const call = createToolCall({
						name: asString(block.name) ?? "unknown_tool",
						input: block.arguments ?? {},
					});
					assembler.addToolCall(call, asString(block.id), at);
				}
			}
		} else if (role === "toolResult") {
			const call = assembler.toolCall(asString(message.toolCallId));
			if (!call) continue;
			const output = textBlocks(message.content);
			setToolOutput(call, output);
			if (typeof message.isError === "boolean") {
				call.isError = message.isError;
				if (call.kind === "shell")
					call.exitCode = message.isError ? exitCodeFromText(output) : 0;
			}
			assembler.resultApplied(call);
		} else if (role === "bashExecution") {
			const command = asString(message.command) ?? "";
			const call = createToolCall({
				name: "bash",
				input: { command },
				kind: "shell",
			});
			setToolOutput(call, message.output);
			const exitCode = asNumber(message.exitCode);
			if (exitCode !== undefined) {
				call.exitCode = exitCode;
				call.isError = exitCode !== 0;
			}
			assembler.addToolCall(call, undefined, at);
			assembler.resultApplied(call);
		}
	}

	return {
		tool: "pi",
		id: header?.id ?? ref.id,
		cwd: header?.cwd ?? ref.cwd,
		model,
		startedAt: header?.timestamp,
		updatedAt: ref.updatedAt,
		title: titleFromPrompt(firstPrompt),
		cliVersion:
			header?.version === undefined
				? undefined
				: `session-format-${header.version}`,
		turns: assembler.finish(),
		readFromStart: true,
		unparsedRecords,
	};
}
