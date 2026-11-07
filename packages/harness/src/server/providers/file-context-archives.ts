import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type ContextArchiveStorage,
	checkpointObjectPrefix,
} from "./context-archive-store";

const ARCHIVE_NAME = /^context-[0-9a-f-]{36}\.enc$/;

/**
 * Context removed from a long run's window, kept as files in one directory
 * for one chat. Plain text: on your own computer the files are as private as
 * the rest of your home directory.
 */
export function fileContextArchives(
	directory: string,
	owner: string,
	session: string,
): ContextArchiveStorage {
	const prefix = checkpointObjectPrefix(owner, session);
	const owned = (user: string, chat: string) => {
		if (user !== owner || chat !== session)
			throw new Error("Archive ownership mismatch.");
	};
	const filename = (path: string) => {
		if (!path.startsWith(prefix))
			throw new Error("Archive ownership mismatch.");
		const name = path.slice(prefix.length);
		if (!ARCHIVE_NAME.test(name))
			throw new Error("Invalid local archive reference.");
		return join(directory, name);
	};
	return {
		async uploadCheckpoint(user, chat, revision, payload) {
			owned(user, chat);
			const path = `${prefix}${revision}.enc`;
			await mkdir(directory, { recursive: true, mode: 0o700 });
			await writeFile(filename(path), payload, { flag: "wx", mode: 0o600 });
			return path;
		},
		async downloadCheckpoint(user, chat, path) {
			owned(user, chat);
			return readFile(filename(path), "utf8");
		},
		async listContextArchives(user, chat, offset = 0, limit = 3) {
			owned(user, chat);
			if (
				!Number.isSafeInteger(offset) ||
				offset < 0 ||
				!Number.isSafeInteger(limit) ||
				limit < 1 ||
				limit > 10
			)
				throw new Error("Invalid archive page.");
			const names = await readdir(directory).catch(() => [] as string[]);
			return names
				.filter((name) => ARCHIVE_NAME.test(name))
				.sort()
				.slice(offset, offset + limit)
				.map((name) => name.slice(0, -4));
		},
	};
}
