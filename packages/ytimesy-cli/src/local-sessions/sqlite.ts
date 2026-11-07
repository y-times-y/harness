/**
 * `node:sqlite`, which OpenCode's and Cursor's stores are read with. It is
 * built in (no flag) from Node 22.13; on older Node it is missing, and those
 * stores cannot be read.
 */
export const SQLITE_MIN_NODE = "22.13";

type Sqlite = typeof import("node:sqlite");

/** The module, or undefined when this Node has none (never throws). */
export function loadSqlite(): Sqlite | undefined {
	try {
		const sqlite = process.getBuiltinModule?.("node:sqlite") as
			| Sqlite
			| undefined;
		return typeof sqlite?.DatabaseSync === "function" ? sqlite : undefined;
	} catch {
		return undefined;
	}
}

export function sqliteAvailable() {
	return loadSqlite() !== undefined;
}
