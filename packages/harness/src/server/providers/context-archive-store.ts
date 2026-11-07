import { createHash, randomUUID } from "node:crypto";
import type { ModelMessage } from "ai";
import { z } from "zod";
import { searchContextMessages } from "../../domain/context-history-search";

export const contextArchiveReference = z
	.string()
	.regex(/^context-[0-9a-f-]{36}$/);

/** Where a chat's archived context lives: a private bucket in the cloud, a directory on a laptop. */
export type ContextArchiveStorage = {
	uploadCheckpoint: (
		userId: string,
		sessionId: string,
		revision: string,
		payload: string,
	) => Promise<unknown>;
	downloadCheckpoint: (
		userId: string,
		sessionId: string,
		path: string,
	) => Promise<string>;
	/** Archive references (`context-<uuid>`), oldest first, one page. */
	listContextArchives: (
		userId: string,
		sessionId: string,
		offset?: number,
		limit?: number,
	) => Promise<string[]>;
};

/** An owner's and a chat's objects share this prefix; hashed so names reveal neither. */
export function checkpointObjectPrefix(userId: string, sessionId: string) {
	return `${createHash("sha256").update(userId).digest("hex")}/${createHash("sha256").update(sessionId).digest("hex")}/`;
}

export async function archiveModelContext(
	userId: string,
	sessionId: string,
	messages: ModelMessage[],
	storage: ContextArchiveStorage,
) {
	const reference = `context-${randomUUID()}`;
	await storage.uploadCheckpoint(
		userId,
		sessionId,
		reference,
		JSON.stringify({ version: 1, messages }),
	);
	return reference;
}

/** Search one bounded page; callers can retrieve exact originals using the returned pointers. */
export async function searchModelContextArchives(
	userId: string,
	sessionId: string,
	query: string,
	offset: number,
	signal: AbortSignal,
	messageOffset = 0,
	alternativeQueries: string[] = [],
	storage: ContextArchiveStorage,
) {
	z.string().trim().min(1).max(200).parse(query);
	z.array(z.string().trim().min(1).max(200)).max(4).parse(alternativeQueries);
	z.number().int().min(0).parse(messageOffset);
	signal.throwIfAborted();
	const references = await storage.listContextArchives(
		userId,
		sessionId,
		offset,
		3,
	);
	const candidates = [];
	for (const reference of references) {
		signal.throwIfAborted();
		const messages = await readModelContextArchive(
			userId,
			sessionId,
			reference,
			storage,
		);
		signal.throwIfAborted();
		for (const match of searchContextMessages(
			messages,
			query,
			alternativeQueries,
		)) {
			candidates.push({ reference, ...match });
		}
	}
	candidates.sort(
		(a, b) =>
			b.score - a.score ||
			a.reference.localeCompare(b.reference) ||
			a.messageIndex - b.messageIndex,
	);
	const matches = candidates.slice(messageOffset, messageOffset + 10);
	if (messageOffset + matches.length < candidates.length)
		return {
			matches,
			nextOffset: offset,
			nextMessageOffset: messageOffset + matches.length,
		};
	return {
		matches,
		nextOffset: references.length === 3 ? offset + 3 : null,
		nextMessageOffset: 0,
	};
}

/** The current authorized chat supplies the scope; a model cannot choose another owner or chat. */
export async function readModelContextArchive(
	userId: string,
	sessionId: string,
	reference: string,
	storage: ContextArchiveStorage,
): Promise<ModelMessage[]> {
	contextArchiveReference.parse(reference);
	const payload = await storage.downloadCheckpoint(
		userId,
		sessionId,
		`${checkpointObjectPrefix(userId, sessionId)}${reference}.enc`,
	);
	const parsed = JSON.parse(payload);
	if (parsed.version !== 1 || !Array.isArray(parsed.messages))
		throw new Error("Invalid context archive.");
	return parsed.messages;
}
