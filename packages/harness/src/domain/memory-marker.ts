import { SessionItemId } from "./ids";
import {
	chatIdFromSource,
	type MemoryChange,
	type MemoryFiles,
	type MemoryLine,
	memoryLines,
	parseMemoryLine,
	trailingMemoryKeys,
} from "./memory-repo";
import type { SessionItem } from "./session-item";

/**
 * What the chat shows of cross-chat memory: the lines a request recalled and
 * the lines a turn saved. Recorded on the session items by the server; the
 * model never sees these records, only the `<memory>` parts it was sent.
 */

export type RecalledMemoryLine = {
	readonly path: string;
	/** The entry without its bullet and metadata. */
	readonly text: string;
	/** A standing project rule attached to every chat (projectRules), not a match for this request. */
	readonly rule?: true;
	/** The chat the entry came from, when its `source:` names one. */
	readonly source?: {
		readonly chatId: string;
		readonly title?: string;
		/** `added:` date (YYYY-MM-DD). */
		readonly date?: string;
	};
};

/**
 * What the read hook did: matched lines, found none above the cutoff,
 * skipped a short or command message, ran out of time, or failed.
 */
export type MemoryReadHookOutcome =
	| "matched"
	| "none"
	| "skipped"
	| "timeout"
	| "error";

/** Another chat's latest message attached because memory may not hold it yet. */
export type RecalledChatMessage = {
	readonly chatId: string;
	readonly title?: string;
	/** The message, clipped for display. */
	readonly text: string;
};

export type MemoryRecall = {
	/** Memory commit when the request was read; this turn's saves are diffed against it. */
	readonly head: string | null;
	/** MEMORY.md (the memory index) was attached at chat start. */
	readonly index?: true;
	/** Non-empty lines of MEMORY.md attached (after the project filter and cap). */
	readonly indexLines?: number;
	readonly lines: readonly RecalledMemoryLine[];
	/** Other chats' recent messages attached with this request. */
	readonly recent?: readonly RecalledChatMessage[];
	/** The read hook's outcome and wall time (full mode with embeddings only). */
	readonly hook?: {
		readonly outcome: MemoryReadHookOutcome;
		readonly ms: number;
		readonly error?: string;
		/**
		 * Where the request's memory time went, in ms (and line counts by
		 * vector source): the snapshot, the wait for other chats' saves (not
		 * part of `ms`), the query embedding, the line vectors and ranking.
		 */
		readonly spans?: Readonly<Record<string, number>>;
	};
};

/**
 * Everything a request's memory put in context, by kind: the index (one
 * item), always-on rules, matched lines and other chats' messages.
 */
export function memoryRecallCounts(recall: MemoryRecall) {
	const rules = recall.lines.filter((line) => line.rule).length;
	const matches = recall.lines.length - rules;
	const index = recall.index ? 1 : 0;
	const recent = recall.recent?.length ?? 0;
	return {
		index,
		rules,
		matches,
		recent,
		total: index + rules + matches + recent,
	};
}

/** "Index · 2 rules · 3 matches · 1 chat message": the count's breakdown, for its tooltip. */
export function memoryRecallBreakdown(recall: MemoryRecall) {
	const counts = memoryRecallCounts(recall);
	const plural = (count: number, one: string, many: string) =>
		`${count} ${count === 1 ? one : many}`;
	return [
		counts.index
			? recall.indexLines
				? `Index (${plural(recall.indexLines, "line", "lines")})`
				: "Index"
			: "",
		counts.rules ? plural(counts.rules, "rule", "rules") : "",
		counts.matches ? plural(counts.matches, "match", "matches") : "",
		counts.recent ? plural(counts.recent, "chat message", "chat messages") : "",
	]
		.filter(Boolean)
		.join(" · ");
}

export type SavedMemoryLine = {
	readonly path: string;
	readonly text: string;
};

const normalized = (text: string) =>
	text.replaceAll(/\s+/g, " ").trim().toLowerCase();

export function recalledMemoryLine(
	entry: Pick<MemoryLine, "path" | "text" | "meta">,
	titles: ReadonlyMap<string, string> = new Map(),
): RecalledMemoryLine {
	const chatId = entry.meta.source ? chatIdFromSource(entry.meta.source) : null;
	const date = /^\d{4}-\d{2}-\d{2}$/.test(entry.meta.added ?? "")
		? entry.meta.added
		: undefined;
	const title = chatId ? titles.get(chatId) : undefined;
	return {
		path: entry.path,
		text: entry.text,
		...(chatId
			? {
					source: {
						chatId,
						...(title ? { title } : {}),
						...(date ? { date } : {}),
					},
				}
			: {}),
	};
}

/**
 * Entries in `after` that cite `chatId` as their source and whose text was
 * not anywhere in `before`: what this chat saved between the two commits.
 * Another chat's concurrent saves cite that chat, so they are not counted.
 */
export function savedMemoryLines(
	before: MemoryFiles,
	after: MemoryFiles,
	chatId: string,
): SavedMemoryLine[] {
	const known = new Set(
		memoryLines(before).map((entry) => normalized(entry.text)),
	);
	const saved: SavedMemoryLine[] = [];
	for (const entry of memoryLines(after)) {
		const key = normalized(entry.text);
		if (
			!key ||
			known.has(key) ||
			!entry.meta.source ||
			chatIdFromSource(entry.meta.source) !== chatId.toLowerCase()
		)
			continue;
		known.add(key);
		saved.push({ path: entry.path, text: entry.text });
	}
	return saved;
}

function lastUserIndex(items: readonly SessionItem[]) {
	for (let index = items.length - 1; index >= 0; index--)
		if (items[index].kind === "userMessage") return index;
	return -1;
}

/** Records the recall on the current request, once: a resumed step keeps the first record. */
export function withMemoryRecall(
	items: readonly SessionItem[],
	recall: MemoryRecall,
): SessionItem[] {
	const index = lastUserIndex(items);
	const current = items[index];
	if (current?.kind !== "userMessage" || current.memory) return [...items];
	const next = [...items];
	next[index] = { ...current, memory: recall };
	return next;
}

/** The recall recorded on the latest request, if memory was read for it. */
export function currentMemoryRecall(items: readonly SessionItem[]) {
	const current = items[lastUserIndex(items)];
	return current?.kind === "userMessage" ? current.memory : undefined;
}

/**
 * Adds saved lines to the turn of `userMessageId`: merged into that turn's
 * marker when it has one (agent and save hook show as one), otherwise a new
 * marker at the end of the turn. Lines already shown are not repeated.
 */
export function withSavedMemory(
	items: readonly SessionItem[],
	userMessageId: string,
	itemId: string,
	lines: readonly SavedMemoryLine[],
): SessionItem[] {
	const start = items.findIndex(
		(item) => item.kind === "userMessage" && item.id === userMessageId,
	);
	if (start < 0 || !lines.length) return [...items];
	let end = start + 1;
	while (end < items.length && items[end].kind !== "userMessage") end++;
	const existingIndex = items.findIndex(
		(item, index) => index > start && index < end && item.kind === "memorySave",
	);
	const existing = items[existingIndex];
	const shown = existing?.kind === "memorySave" ? existing.lines : [];
	const added = lines.filter(
		(line, index) =>
			![...shown, ...lines.slice(0, index)].some(
				(other) =>
					other.path === line.path &&
					normalized(other.text) === normalized(line.text),
			),
	);
	if (!added.length) return [...items];
	if (existing?.kind === "memorySave") {
		const next = [...items];
		next[existingIndex] = { ...existing, lines: [...shown, ...added] };
		return next;
	}
	return [
		...items.slice(0, end),
		{ kind: "memorySave", id: SessionItemId(itemId), lines: added },
		...items.slice(end),
	];
}

function holdsIn(content: string | undefined, key: string) {
	return Boolean(
		content
			?.split("\n")
			.some((raw) => normalized(parseMemoryLine(raw)?.text ?? "") === key),
	);
}

/**
 * The file that holds this entry: its own, else (a line the per-project
 * layout moved: `tooling.md` -> `personal/tooling.md`) the one file of the
 * same topic name that holds it. Null when memory no longer holds it.
 */
function holdingPath(files: MemoryFiles, line: SavedMemoryLine) {
	// Older records kept trailing key text ("kind: inferred.") in the line.
	const key = normalized(trailingMemoryKeys(line.text).text);
	if (holdsIn(files[line.path], key)) return line.path;
	const name = `/${line.path.split("/").pop() ?? line.path}`;
	const moved = Object.keys(files).filter(
		(path) => path.endsWith(name) && holdsIn(files[path], key),
	);
	return moved.length === 1 ? moved[0] : null;
}

/** Whether memory still holds this entry (by its text, in its file or where the layout moved it). */
export function memoryHoldsLine(files: MemoryFiles, line: SavedMemoryLine) {
	return holdingPath(files, line) !== null;
}

/** Undo: the file without the entry, or null when memory no longer holds it. */
export function withoutMemoryLine(
	files: MemoryFiles,
	line: SavedMemoryLine,
): MemoryChange | null {
	const path = holdingPath(files, line);
	if (path === null) return null;
	const key = normalized(trailingMemoryKeys(line.text).text);
	const kept = (files[path] ?? "")
		.split("\n")
		.filter((raw) => normalized(parseMemoryLine(raw)?.text ?? "") !== key);
	return { path, content: kept.join("\n") };
}
