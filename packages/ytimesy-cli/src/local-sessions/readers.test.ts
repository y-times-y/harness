import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverClaudeSessions, readClaudeSession } from "./claude.ts";
import { discoverCodexSessions, readCodexSession } from "./codex.ts";
import { discoverGrokSessions, readGrokSession } from "./grok.ts";
import {
	discoverSessions,
	findLatestSession,
	readSession,
	readSessionActivity,
} from "./index.ts";
import { linesBackward } from "./io.ts";
import { discoverOpencodeSessions, readOpencodeSession } from "./opencode.ts";
import { discoverPiSessions, readPiSession } from "./pi.ts";
import {
	claude21Records,
	claudeCompactedRecords,
	claudeFile,
	claudeLegacyRecords,
	codexBareRecords,
	codexItemModeRecords,
	codexLegacyRecords,
	createFixtureWorld,
	type FixtureWorld,
	grokChatHistory,
	grokUpdates,
	piRecords,
	required,
	setMtime,
	writeJsonl,
} from "./test-fixtures.ts";
import type { LocalSession, ToolCall } from "./types.ts";

const ENV_KEYS = [
	"CODEX_HOME",
	"PI_CODING_AGENT_DIR",
	"OPENCODE_DB",
	"XDG_DATA_HOME",
] as const;
let world: FixtureWorld;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

beforeEach(() => {
	world = createFixtureWorld();
	for (const key of ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
});

afterEach(() => {
	world.cleanup();
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
});

function calls(session: LocalSession): ToolCall[] {
	return session.turns.flatMap((turn) => turn.toolCalls);
}

describe("io", () => {
	it("reads lines backwards across chunk boundaries and multi-byte characters", () => {
		const file = path.join(world.home, "lines.txt");
		fs.writeFileSync(file, "first ✓\n\nsecond line é\nthird 漢字 line");
		expect([...linesBackward(file, 3)]).toEqual([
			"third 漢字 line",
			"second line é",
			"first ✓",
		]);
	});
});

describe("Claude Code reader", () => {
	it("reads the 2.1.x shape with exit codes, paths, title and metadata", () => {
		const cwd = path.join(world.repo, "packages", "app");
		writeJsonl(claudeFile(world.home, cwd, "c21"), claude21Records(cwd));
		const [ref] = discoverClaudeSessions(world.repo, world.home);
		expect(ref?.id).toBe("c21");
		const session = readClaudeSession(required(ref));
		expect(session).toMatchObject({
			gitBranch: "feature-x",
			model: "claude-test-1",
			cliVersion: "2.1.296",
			title: "Parser fix",
			startedAt: "2026-01-01T00:00:01.000Z",
			readFromStart: true,
		});
		expect(session.turns.map((turn) => [turn.role, turn.text])).toEqual([
			["user", "fix the parser please"],
			["assistant", "Running the tests first.\n\nFixed."],
		]);
		const [install, test, read, edit, sed] = calls(session);
		expect(install).toMatchObject({
			kind: "shell",
			command: "npm install",
			exitCode: 0,
			isError: false,
		});
		expect(test).toMatchObject({
			command: "npm test",
			exitCode: 1,
			isError: true,
		});
		expect(read).toMatchObject({
			kind: "read",
			paths: [`${cwd}/src/parser.ts`],
		});
		expect(edit).toMatchObject({
			kind: "edit",
			changedPaths: [`${cwd}/src/parser.ts`],
		});
		expect(sed?.changedPaths).toEqual([`${cwd}/src/lexer.ts`]);
	});

	it("reads the 1.x shape, skips sidechain records and counts unparsable lines", () => {
		const file = writeJsonl(
			claudeFile(world.home, world.repo, "old"),
			claudeLegacyRecords(world.repo),
		);
		fs.appendFileSync(file, '{"type":"user", broken\n');
		const [ref] = discoverClaudeSessions(world.repo, world.home);
		const session = readClaudeSession(required(ref));
		expect(session.title).toBe("Legacy session title");
		expect(session.turns.map((turn) => turn.text)).toEqual([
			"list files",
			"Listing.",
		]);
		expect(calls(session)[0]).toMatchObject({
			kind: "search",
			name: "LS",
			output: "a.txt",
		});
		expect(session.unparsedRecords).toBe(1);
	});

	it("does not match a sibling directory that shares the repo name as a prefix", () => {
		const sibling = `${world.repo}-other`;
		fs.mkdirSync(sibling, { recursive: true });
		writeJsonl(claudeFile(world.home, sibling, "s"), claude21Records(sibling));
		expect(discoverClaudeSessions(world.repo, world.home)).toEqual([]);
	});

	it("stops a budgeted backward read at the compaction summary", () => {
		writeJsonl(
			claudeFile(world.home, world.repo, "cc"),
			claudeCompactedRecords(world.repo),
		);
		const [ref] = discoverClaudeSessions(world.repo, world.home);
		const session = readClaudeSession(required(ref), { budgetChars: 100_000 });
		expect(session.readFromStart).toBe(false);
		expect(session.turns[0]).toMatchObject({ synthetic: "compaction-summary" });
		expect(session.turns.slice(1).map((turn) => turn.text)).toEqual([
			"continue with the lexer",
			"On it.",
		]);
		expect(session.startedAt).toBe("2026-01-02T00:00:00.000Z");
		expect(session.title).toBe("old request");
	});

	it("keeps the newest compaction summary when the budget runs out before reaching it", () => {
		const records: object[] = claudeCompactedRecords(world.repo);
		for (let index = 0; index < 20; index++) {
			records.push({
				type: "user",
				cwd: world.repo,
				message: {
					role: "user",
					content: `later prompt ${index} ${"x".repeat(200)}`,
				},
			});
		}
		writeJsonl(claudeFile(world.home, world.repo, "cc"), records);
		const [ref] = discoverClaudeSessions(world.repo, world.home);
		const session = readClaudeSession(required(ref), { budgetChars: 500 });
		expect(session.readFromStart).toBe(false);
		expect(session.turns[0]).toMatchObject({ synthetic: "compaction-summary" });
		const newest = session.turns.at(-1)?.text ?? "";
		expect(newest).toContain("later prompt 19");
		expect(newest).not.toContain("later prompt 0 ");
		expect(session.turns.map((turn) => turn.text).join()).not.toContain(
			"old request",
		);
	});
});

describe("Codex reader", () => {
	const rollout = (name: string) =>
		path.join(world.home, ".codex", "sessions", "2026", "02", "01", name);

	it("uses item_completed events (0.16x) and skips the code-mode exec wrapper", () => {
		writeJsonl(
			rollout("rollout-2026-02-01T00-00-00-item.jsonl"),
			codexItemModeRecords(world.repo),
		);
		const [ref] = discoverCodexSessions(world.repo, world.home);
		const session = readCodexSession(required(ref));
		expect(session).toMatchObject({
			id: "01a0-item",
			gitBranch: "main",
			model: "gpt-test",
			cliVersion: "0.161.0",
		});
		expect(session.turns.map((turn) => [turn.role, turn.text])).toEqual([
			["user", "install and test"],
			["assistant", "Installed; one test fails."],
		]);
		expect(
			calls(session).map((call) => [
				call.kind,
				call.command ?? call.name,
				call.exitCode,
			]),
		).toEqual([
			["shell", "pnpm install", 0],
			["shell", "cat README.md", 0],
			["shell", "pnpm test", 1],
			["edit", "apply_patch", undefined],
		]);
		expect(calls(session)[1]?.paths).toEqual([
			path.join(world.repo, "README.md"),
		]);
		expect(calls(session)[3]?.changedPaths).toEqual([`${world.repo}/src/a.ts`]);
	});

	it("reads wrapped rollouts with function calls, exec_command_end and a compaction summary", () => {
		writeJsonl(
			rollout("rollout-2025-09-01T00-00-00-legacy.jsonl"),
			codexLegacyRecords(world.repo),
		);
		const [ref] = discoverCodexSessions(world.repo, world.home);
		const session = readCodexSession(required(ref));
		expect(session.turns[0]).toMatchObject({ role: "user", text: "build it" });
		const [build, lint, patch, test] = calls(session);
		expect(build).toMatchObject({
			command: "make build",
			exitCode: 0,
			output: "built",
		});
		expect(lint).toMatchObject({
			command: "make lint",
			exitCode: 2,
			isError: true,
		});
		expect(patch).toMatchObject({
			kind: "edit",
			changedPaths: ["src/main.c", "src/new.c"],
			isError: false,
		});
		expect(test).toMatchObject({ command: "make test", exitCode: 0 });
		expect(
			session.turns.some((turn) => turn.synthetic === "compaction-summary"),
		).toBe(true);
	});

	it("reads pre-wrapper rollouts and finds the cwd in the environment context", () => {
		const file = path.join(
			world.home,
			".codex",
			"sessions",
			"rollout-2025-04-01-bare.jsonl",
		);
		writeJsonl(file, codexBareRecords(world.repo));
		const [ref] = discoverCodexSessions(world.repo, world.home);
		expect(ref).toMatchObject({ id: "bare-1", cwd: world.repo });
		const session = readCodexSession(required(ref));
		expect(session.turns.map((turn) => turn.text)).toEqual(["say hi", "hi"]);
		expect(calls(session)[0]).toMatchObject({
			command: "echo hi",
			exitCode: 0,
		});
	});

	it("skips an empty rollout file", () => {
		const empty = rollout("rollout-empty.jsonl");
		fs.mkdirSync(path.dirname(empty), { recursive: true });
		fs.writeFileSync(empty, "");
		expect(discoverCodexSessions(world.repo, world.home)).toEqual([]);
	});
});

describe("OpenCode reader", () => {
	function createDatabase(directory: string): string {
		const databasePath = path.join(
			world.home,
			".local",
			"share",
			"opencode",
			"opencode.db",
		);
		fs.mkdirSync(path.dirname(databasePath), { recursive: true });
		const sqlite = process.getBuiltinModule(
			"node:sqlite",
		) as typeof import("node:sqlite");
		const database = new sqlite.DatabaseSync(databasePath);
		database.exec(`
			CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT NOT NULL, title TEXT NOT NULL,
				version TEXT NOT NULL, model TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER);
			CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
				time_updated INTEGER NOT NULL, data TEXT NOT NULL);
			CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
				time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
		`);
		const insertSession = database.prepare(
			"INSERT INTO session (id, parent_id, directory, title, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
		);
		insertSession.run(
			"ses_1",
			null,
			directory,
			"New session - 2026-05-01T00:00:00.000Z",
			"1.18.32",
			1000,
			5000,
		);
		insertSession.run(
			"ses_child",
			"ses_1",
			directory,
			"child",
			"1.18.32",
			1000,
			9000,
		);
		const message = database.prepare(
			"INSERT INTO message VALUES (?, 'ses_1', ?, ?, ?)",
		);
		const part = database.prepare(
			"INSERT INTO part VALUES (?, ?, 'ses_1', 0, 0, ?)",
		);
		message.run("msg_1", 1, 1, JSON.stringify({ role: "user" }));
		part.run(
			"prt_1",
			"msg_1",
			JSON.stringify({ type: "text", text: "run the tests" }),
		);
		message.run(
			"msg_2",
			2,
			2,
			JSON.stringify({ role: "assistant", providerID: "p", modelID: "m" }),
		);
		part.run(
			"prt_2",
			"msg_2",
			JSON.stringify({ type: "reasoning", text: "hidden" }),
		);
		part.run(
			"prt_3",
			"msg_2",
			JSON.stringify({
				type: "tool",
				tool: "bash",
				callID: "c1",
				state: {
					status: "completed",
					input: { command: "bun test" },
					output: "pass",
					metadata: { exit: 0 },
				},
			}),
		);
		part.run(
			"prt_4",
			"msg_2",
			JSON.stringify({
				type: "tool",
				tool: "edit",
				callID: "c2",
				state: {
					status: "error",
					input: { filePath: "src/x.ts" },
					error: "no match",
				},
			}),
		);
		message.run(
			"msg_3",
			3,
			3,
			JSON.stringify({ role: "assistant", summary: true, modelID: "m" }),
		);
		part.run(
			"prt_5",
			"msg_3",
			JSON.stringify({ type: "text", text: "Summary of the session." }),
		);
		message.run(
			"msg_4",
			4,
			4,
			JSON.stringify({ role: "assistant", modelID: "m", providerID: "p" }),
		);
		part.run(
			"prt_6",
			"msg_4",
			JSON.stringify({ type: "text", text: "All tests pass." }),
		);
		database.close();
		return databasePath;
	}

	it("reads sessions from SQLite, skipping child sessions", () => {
		createDatabase(path.join(world.repo, "packages", "app"));
		const [ref] = discoverOpencodeSessions(world.repo, world.home);
		expect(ref).toMatchObject({ id: "ses_1", updatedAt: 5000 });
		const session = readOpencodeSession(required(ref));
		expect(session).toMatchObject({
			model: "p/m",
			cliVersion: "1.18.32",
			title: "run the tests",
		});
		expect(session.turns.map((turn) => turn.synthetic ?? turn.text)).toEqual([
			"run the tests",
			"",
			"compaction-summary",
			"All tests pass.",
		]);
		expect(calls(session)).toMatchObject([
			{ kind: "shell", command: "bun test", exitCode: 0, isError: false },
			{ kind: "edit", isError: true, paths: ["src/x.ts"] },
		]);
	});
});

describe("Pi reader", () => {
	it("follows the current branch and places the compaction before its first kept entry", () => {
		const directory = path.join(
			world.home,
			".pi",
			"agent",
			"sessions",
			`--${world.repo.slice(1).replace(/\//g, "-")}--`,
		);
		writeJsonl(
			path.join(directory, "2026-03-01_pi-1.jsonl"),
			piRecords(world.repo),
		);
		const [ref] = discoverPiSessions(world.repo, world.home);
		const session = readPiSession(required(ref));
		expect(session.model).toBe("prov/model-a");
		const texts = session.turns.map((turn) => turn.synthetic ?? turn.text);
		expect(texts).toEqual([
			"first ask",
			"",
			"compaction-summary",
			"",
			"now fix the test",
		]);
		expect(texts).not.toContain("abandoned branch prompt");
		expect(calls(session).map((call) => [call.command, call.exitCode])).toEqual(
			[
				["go build ./...", 0],
				["go test ./...", 1],
				["go vet ./...", 0],
			],
		);
	});
});

describe("Grok reader", () => {
	const sessionDirectory = () =>
		path.join(
			world.home,
			".grok",
			"sessions",
			encodeURIComponent(world.repo),
			"grok-session-1",
		);

	it("reads updates.jsonl with concatenated chunks, exit codes and the recap first", () => {
		writeJsonl(path.join(sessionDirectory(), "updates.jsonl"), grokUpdates());
		fs.writeFileSync(
			path.join(sessionDirectory(), "summary.json"),
			JSON.stringify({
				info: { id: "grok-session-1", cwd: world.repo },
				generated_title: "Build",
				current_model_id: "grok-x",
			}),
		);
		const [ref] = discoverGrokSessions(world.repo, world.home);
		const session = readGrokSession(required(ref));
		expect(session).toMatchObject({ title: "Build", model: "grok-x" });
		expect(session.turns.map((turn) => turn.synthetic ?? turn.text)).toEqual([
			"compaction-summary",
			"run the build",
			"Running it now.",
		]);
		expect(calls(session)).toMatchObject([
			{
				kind: "shell",
				command: "cargo build",
				exitCode: 0,
				output: "Finished",
			},
			{ kind: "edit", paths: ["src/lib.rs"], output: "edited" },
		]);
	});

	it("falls back to chat_history.jsonl", () => {
		writeJsonl(
			path.join(sessionDirectory(), "chat_history.jsonl"),
			grokChatHistory(),
		);
		const [ref] = discoverGrokSessions(world.repo, world.home);
		const session = readGrokSession(required(ref));
		expect(session.turns.map((turn) => turn.text)).toEqual([
			"list files",
			"Listing.\n\nTwo files.",
		]);
		expect(calls(session)[0]).toMatchObject({ command: "ls", output: "a\nb" });
	});
});

describe("discovery across tools", () => {
	it("returns the newest session whose cwd is inside the repo, resolving the git root", () => {
		const claude = writeJsonl(
			claudeFile(world.home, world.repo, "c21"),
			claude21Records(world.repo),
		);
		const codex = writeJsonl(
			path.join(
				world.home,
				".codex",
				"sessions",
				"2026",
				"02",
				"01",
				"rollout-x.jsonl",
			),
			codexItemModeRecords(path.join(world.repo, "packages")),
		);
		setMtime(claude, Date.parse("2026-02-01T00:00:00Z"));
		setMtime(codex, Date.parse("2026-02-02T00:00:00Z"));
		const latest = findLatestSession(path.join(world.repo, "packages", "app"), {
			home: world.home,
		});
		expect(latest?.tool).toBe("codex");
		setMtime(claude, Date.parse("2026-02-03T00:00:00Z"));
		expect(findLatestSession(world.repo, { home: world.home })?.tool).toBe(
			"claude",
		);
		expect(
			discoverSessions(world.repo, { home: world.home, tools: ["pi"] }),
		).toEqual([]);
	});

	it("readSessionActivity covers the whole session, independent of the conversation budget", () => {
		writeJsonl(
			claudeFile(world.home, world.repo, "c21"),
			claude21Records(world.repo),
		);
		const ref = findLatestSession(world.repo, { home: world.home });
		const activity = readSessionActivity(required(ref), { root: world.repo });
		expect(activity.successfulCommands).toEqual([
			"npm install",
			"sed -i '' s/a/b/ src/lexer.ts",
		]);
		expect(activity.files).toEqual({
			edited: ["src/parser.ts", "src/lexer.ts"],
			written: [],
			read: [],
		});
		const tail = readSession(required(ref), { budgetChars: 10 });
		expect(tail.turns.length).toBeGreaterThan(0);
	});
});
