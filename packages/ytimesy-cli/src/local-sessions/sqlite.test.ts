import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { discoverAllSessions, sqliteWarning } from "./machine.ts";
import { loadSqlite } from "./sqlite.ts";

it("loads node:sqlite on this Node without throwing", () => {
	expect(typeof loadSqlite()?.DatabaseSync).toBe("function");
});

it("names the skipped agents in one line, Cursor's two stores once", () => {
	expect(sqliteWarning([], "22.12.0")).toBeNull();
	expect(sqliteWarning(["opencode", "cursor", "cursor-agent"], "22.12.0")).toBe(
		"Warning: OpenCode and Cursor sessions were skipped: reading them needs Node 22.13 or newer (this is Node 22.12.0).",
	);
});

it("reports SQLite stores it cannot read instead of skipping them silently", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "ytimesy-sqlite-"));
	try {
		fs.mkdirSync(path.join(home, ".cursor", "chats"), { recursive: true });
		const saved = process.env.XDG_DATA_HOME;
		delete process.env.XDG_DATA_HOME;
		const savedConfig = process.env.CURSOR_CONFIG_DIR;
		delete process.env.CURSOR_CONFIG_DIR;
		const savedXdg = process.env.XDG_CONFIG_HOME;
		delete process.env.XDG_CONFIG_HOME;
		try {
			const result = discoverAllSessions({ home, sqlite: false });
			expect(result.needsNewerNode).toEqual(["cursor-agent"]);
			expect(result.errors["cursor-agent"]).toMatch(/Node 22\.13/);
			expect(discoverAllSessions({ home }).needsNewerNode).toEqual([]);
		} finally {
			if (saved !== undefined) process.env.XDG_DATA_HOME = saved;
			if (savedConfig !== undefined)
				process.env.CURSOR_CONFIG_DIR = savedConfig;
			if (savedXdg !== undefined) process.env.XDG_CONFIG_HOME = savedXdg;
		}
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});
