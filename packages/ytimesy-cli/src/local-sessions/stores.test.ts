import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	agentsFromEnvironment,
	detectCallingAgent,
	trimImportTail,
} from "./caller.ts";
import { discoverCodexSessions, readCodexSession } from "./codex.ts";
import {
	discoverCursorAgentSessions,
	readCursorAgentSession,
} from "./cursor-agent.ts";
import {
	discoverCursorSessions,
	listCursorSessionRefs,
	readCursorSession,
} from "./cursor-app.ts";
import { exportFullTranscript } from "./full-transcript.ts";
import {
	discoverGeminiSessions,
	geminiCheckpointRef,
	listGeminiSessionRefs,
	readGeminiSession,
} from "./gemini.ts";
import { clearGitIdentityCache, gitIdentity, normalizeRemote } from "./git.ts";
import {
	discoverAllSessions,
	findLatestSession,
	findSessionToImport,
	readSession,
	readSessionActivity,
} from "./index.ts";
import {
	claude21Records,
	claudeFile,
	codexItemModeRecords,
	createFixtureWorld,
	type FixtureWorld,
	required,
	setMtime,
	writeJsonl,
} from "./test-fixtures.ts";
import {
	addCursorWorkspace,
	blobComposer,
	bubbleComposer,
	createCursorApp,
	emptyComposer,
	futureComposer,
	geminiCheckpointHistory,
	geminiHash,
	geminiJsonlRecords,
	geminiLegacySession,
	geminiProject,
	inlineComposer,
	putHeader,
	writeCursorAgentChat,
	writeGeminiJsonl,
} from "./test-fixtures-stores.ts";
import { createToolCall } from "./tool-calls.ts";
import type { LocalSession, ToolCall, Turn } from "./types.ts";

const ENV_KEYS = [
	"CODEX_HOME",
	"PI_CODING_AGENT_DIR",
	"OPENCODE_DB",
	"XDG_DATA_HOME",
	"XDG_CONFIG_HOME",
	"APPDATA",
	"GEMINI_CLI_HOME",
	"CURSOR_CONFIG_DIR",
] as const;
let world: FixtureWorld;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

beforeEach(() => {
	world = createFixtureWorld();
	clearGitIdentityCache();
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

function originConfig(url: string): string {
	return `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`;
}

describe("Gemini CLI reader", () => {
	it("reads a 0.40 JSONL session: re-appended messages, $set title, $rewindTo, shell exit codes", () => {
		const project = geminiProject(world.home, world.repo, "repo");
		writeGeminiJsonl(
			project,
			"session-2026-10-30T10-00-gemsess1.jsonl",
			geminiJsonlRecords(world.repo),
		);
		const [ref] = discoverGeminiSessions(world.repo, world.home);
		expect(ref).toMatchObject({
			tool: "gemini",
			id: "gem-session-1",
			cwd: world.repo,
		});
		const session = readGeminiSession(required(ref));
		expect(session).toMatchObject({
			title: "Fix failing app test",
			model: "gemini-3-flash",
			startedAt: "2026-10-30T10:00:00.000Z",
			unparsedRecords: 1,
		});
		expect(session.turns.map((turn) => [turn.role, turn.text])).toEqual([
			["user", "Fix the failing test in src/app.ts"],
			["assistant", "I'll look at the test first."],
			["user", "Now commit it"],
			["assistant", "Committed."],
		]);
		expect(
			calls(session).map((call) => [
				call.kind,
				call.command ?? call.name,
				call.exitCode,
				call.isError,
			]),
		).toEqual([
			["shell", "npm test", 1, true],
			["edit", "replace", undefined, false],
			["shell", "npm test", 0, false],
		]);
		expect(calls(session)[1]?.changedPaths).toEqual([
			`${world.repo}/src/app.ts`,
		]);
		expect(session.turns[0]?.at).toBe("2026-10-30T10:00:00.000Z");
	});

	it("maps a legacy sha256 project folder and reads the pre-JSONL session file", () => {
		const legacyDirectory = path.join(
			world.home,
			".gemini",
			"tmp",
			geminiHash(world.repo),
		);
		fs.mkdirSync(path.join(legacyDirectory, "chats"), { recursive: true });
		fs.writeFileSync(
			path.join(
				legacyDirectory,
				"chats",
				"session-2025-08-01T09-00-legacy01.json",
			),
			JSON.stringify(geminiLegacySession(world.repo)),
		);
		const [ref] = discoverGeminiSessions(world.repo, world.home);
		const session = readGeminiSession(required(ref));
		expect(session.id).toBe("gem-legacy-1");
		expect(session.title).toBe("List the files");
		expect(calls(session).map((call) => [call.command, call.exitCode])).toEqual(
			[["ls", 0]],
		);
	});

	it("reads /chat save checkpoints and prompt-log-only sessions; skips subagent files", () => {
		const project = geminiProject(world.home, world.repo, "repo");
		const checkpoint = path.join(project, "checkpoint-my%20tag.json");
		fs.writeFileSync(checkpoint, JSON.stringify(geminiCheckpointHistory()));
		const fromCheckpoint = readGeminiSession(
			required(geminiCheckpointRef(checkpoint, world.repo)),
		);
		expect(fromCheckpoint.id).toBe("checkpoint:my tag");
		expect(
			calls(fromCheckpoint).map((call) => [call.command, call.exitCode]),
		).toEqual([["make", 2]]);

		fs.writeFileSync(
			path.join(project, "logs.json"),
			JSON.stringify([
				{
					sessionId: "old-session-xyz",
					messageId: 0,
					type: "user",
					message: "hello there",
					timestamp: "2025-06-01T00:00:00.000Z",
				},
			]),
		);
		writeGeminiJsonl(project, "parent-id/sub-agent.jsonl", [
			{
				sessionId: "sub",
				projectHash: "x",
				startTime: "t",
				lastUpdated: "t",
				kind: "subagent",
			},
		]);
		const refs = listGeminiSessionRefs(world.home);
		expect(refs.map((ref) => ref.id)).toEqual(["old-session-xyz"]);
		const fromLog = readGeminiSession(required(refs[0]));
		expect(fromLog.turns.map((turn) => turn.text)).toEqual(["hello there"]);
	});
});

describe("Cursor CLI reader", () => {
	it("reads store.db: model, injected context skipped, Shell exit codes, StrReplace edits", () => {
		writeCursorAgentChat(world.home, world.repo, "chat-1");
		const [ref] = discoverCursorAgentSessions(world.repo, world.home);
		expect(ref).toMatchObject({
			tool: "cursor-agent",
			id: "chat-1",
			cwd: world.repo,
		});
		const session = readCursorAgentSession(required(ref));
		expect(session).toMatchObject({
			model: "fixture-model-1",
			title: "Run the tests and fix notes.txt",
			unparsedRecords: 0,
		});
		expect(session.unsupported).toBeUndefined();
		expect(session.turns.map((turn) => [turn.role, turn.text])).toEqual([
			["user", "Run the tests and fix notes.txt"],
			["assistant", "Done."],
		]);
		expect(
			calls(session).map((call) => [
				call.kind,
				call.command ?? call.name,
				call.exitCode,
				call.isError,
			]),
		).toEqual([
			["shell", "npm test", 0, false],
			["shell", "ls /missing", 1, true],
			["edit", "StrReplace", undefined, false],
		]);
		expect(
			readSessionActivity(required(ref), { root: world.repo }).files.edited,
		).toEqual(["notes.txt"]);
	});

	it("takes the cwd from the conversation root without meta.json, and reports an unrecognized store", () => {
		writeCursorAgentChat(world.home, world.repo, "chat-old", {
			withMeta: false,
		});
		const [ref] = discoverCursorAgentSessions(world.repo, world.home);
		expect(ref?.cwd).toBe(world.repo);

		const other = path.join(world.repo, "packages", "app");
		writeCursorAgentChat(world.home, other, "chat-bad", {
			storeMeta: "missing",
			updatedAtMs: 1893560530151,
		});
		const refs = discoverCursorAgentSessions(world.repo, world.home, 5);
		const bad = readCursorAgentSession(
			required(refs.find((candidate) => candidate.id === "chat-bad")),
		);
		expect(bad.turns).toEqual([]);
		expect(bad.unsupported).toMatch(/unsupported Cursor CLI store/);
	});
});

describe("Cursor app reader", () => {
	function app() {
		const fixture = createCursorApp(world.home);
		bubbleComposer(fixture, "comp-bubbles", world.repo);
		inlineComposer(fixture, "comp-inline");
		blobComposer(fixture, "comp-blobs", world.repo);
		emptyComposer(fixture, "comp-empty");
		futureComposer(fixture, "comp-future");
		addCursorWorkspace(fixture, "ws1", world.repo, [
			"comp-bubbles",
			"comp-inline",
			"comp-empty",
			"comp-future",
		]);
		putHeader(fixture.stateFile, "comp-blobs", "ws1");
		return fixture;
	}

	it("reads bubble composers with shell exit codes (omitted zero), rejection, edits and summary", () => {
		app();
		const refs = discoverCursorSessions(world.repo, world.home, 10);
		expect(refs.map((ref) => ref.id)).toEqual([
			"comp-future",
			"comp-blobs",
			"comp-bubbles",
			"comp-inline",
		]);
		const session = readCursorSession(
			required(refs.find((ref) => ref.id === "comp-bubbles")),
		);
		expect(session).toMatchObject({
			title: "Build fix",
			model: "fixture-app-model",
			cliVersion: "composer-v10",
			cwd: world.repo,
			unparsedRecords: 1,
		});
		expect(
			calls(session).map((call) => [
				call.kind,
				call.command ?? call.name,
				call.exitCode,
				call.isError,
			]),
		).toEqual([
			["shell", "npm run build", 0, false],
			["shell", "npm test", 1, true],
			["shell", "rm -rf /", undefined, true],
			["edit", "edit_file_v2", undefined, false],
		]);
		expect(
			session.turns.map((turn) => [turn.role, turn.synthetic ?? turn.text]),
		).toEqual([
			["user", "Make the build pass"],
			["assistant", ""],
			["user", "compaction-summary"],
			["assistant", "Fixed the build."],
		]);
		expect(session.turns[0]?.at).toBe("2026-10-01T10:00:00.000Z");
	});

	it("reads inline (no _v) and conversationState-only (_v 18) composers, flags unknown shapes", () => {
		app();
		const refs = discoverCursorSessions(world.repo, world.home, 10);
		const inline = readCursorSession(
			required(refs.find((ref) => ref.id === "comp-inline")),
		);
		expect(inline.turns.map((turn) => turn.text)).toEqual([
			"What does main.py do?",
			"It prints hello.",
		]);
		const blobs = readCursorSession(
			required(refs.find((ref) => ref.id === "comp-blobs")),
		);
		expect(blobs.model).toBe("fixture-model-1");
		expect(calls(blobs).map((call) => call.exitCode)).toEqual([
			0,
			1,
			undefined,
		]);
		const future = readCursorSession(
			required(refs.find((ref) => ref.id === "comp-future")),
		);
		expect(future.turns).toEqual([]);
		expect(future.unsupported).toMatch(
			/unsupported Cursor version \(composer _v=99\)/,
		);
	});

	it("maps composers to folders through composerHeaders and lists machine-wide refs", () => {
		const fixture = createCursorApp(world.home);
		const elsewhere = path.join(world.home, "other-project");
		fs.mkdirSync(elsewhere, { recursive: true });
		bubbleComposer(fixture, "comp-h", elsewhere);
		addCursorWorkspace(fixture, "ws-other", elsewhere, []);
		putHeader(fixture.stateFile, "comp-h", "ws-other");
		expect(discoverCursorSessions(world.repo, world.home)).toEqual([]);
		expect(
			discoverCursorSessions(elsewhere, world.home).map((ref) => ref.id),
		).toEqual(["comp-h"]);
		expect(
			listCursorSessionRefs(world.home).map((ref) => [ref.id, ref.cwd]),
		).toEqual([["comp-h", elsewhere]]);
	});

	it("exports the full transcript for the new tools", () => {
		app();
		const ref = discoverCursorSessions(world.repo, world.home, 5).find(
			(candidate) => candidate.id === "comp-blobs",
		);
		const result = exportFullTranscript(required(ref), {
			outputFile: path.join(world.home, "out", "t.md"),
		});
		expect(result.toolCalls).toBe(3);
		expect(fs.readFileSync(result.transcriptFile, "utf8")).toContain(
			"ls /missing",
		);
	});
});

describe("Codex fixes", () => {
	const rollouts = () =>
		path.join(world.home, ".codex", "sessions", "2026", "02", "01");

	it("reads compressed .jsonl.zst rollouts", () => {
		const zstd = (zlib as { zstdCompressSync?: (data: Buffer) => Buffer })
			.zstdCompressSync;
		if (!zstd) return;
		const plain = writeJsonl(
			path.join(world.home, "tmp.jsonl"),
			codexItemModeRecords(world.repo),
		);
		fs.mkdirSync(rollouts(), { recursive: true });
		fs.writeFileSync(
			path.join(rollouts(), "rollout-2026-02-01T00-00-00-01a0-item.jsonl.zst"),
			zstd(fs.readFileSync(plain)),
		);
		const [ref] = discoverCodexSessions(world.repo, world.home);
		const session = readCodexSession(required(ref));
		expect(session.id).toBe("01a0-item");
		expect(calls(session).map((call) => call.exitCode)).toEqual([
			0,
			0,
			1,
			undefined,
		]);
	});

	it("merges item_completed events into the response call with the same id (0.117-0.149)", () => {
		writeJsonl(
			path.join(rollouts(), "rollout-2026-02-01T00-00-00-merge.jsonl"),
			[
				{
					timestamp: "t0",
					type: "session_meta",
					payload: { id: "merge-1", cwd: world.repo, cli_version: "0.122.0" },
				},
				{
					timestamp: "t1",
					type: "response_item",
					payload: {
						type: "message",
						role: "user",
						content: [{ type: "input_text", text: "run it" }],
					},
				},
				{
					timestamp: "t2",
					type: "event_msg",
					payload: {
						type: "item_completed",
						item: { type: "AgentMessage", id: "am1" },
					},
				},
				{
					timestamp: "t3",
					type: "response_item",
					payload: {
						type: "function_call",
						name: "exec_command",
						call_id: "c1",
						arguments: JSON.stringify({ cmd: "make" }),
					},
				},
				{
					timestamp: "t4",
					type: "response_item",
					payload: {
						type: "function_call_output",
						call_id: "c1",
						output: "done",
					},
				},
				{
					timestamp: "t5",
					type: "event_msg",
					payload: {
						type: "item_completed",
						item: {
							type: "CommandExecution",
							id: "c1",
							command: "make",
							exit_code: 2,
							status: "failed",
						},
					},
				},
				{
					timestamp: "t6",
					type: "event_msg",
					payload: {
						type: "item_completed",
						item: { type: "WebSearch", id: "ws1", query: "docs" },
					},
				},
			],
		);
		const [ref] = discoverCodexSessions(world.repo, world.home);
		const session = readCodexSession(required(ref));
		expect(
			calls(session).map((call) => [call.name, call.command, call.exitCode]),
		).toEqual([
			["exec_command", "make", 2],
			["web_search", undefined, undefined],
		]);
	});

	it("matches Codex Desktop worktree sessions to their repository", () => {
		fs.writeFileSync(
			path.join(world.repo, ".git", "config"),
			originConfig("git@github.com:acme/widgets.git"),
		);
		fs.writeFileSync(
			path.join(world.repo, ".git", "HEAD"),
			"ref: refs/heads/main\n",
		);
		const worktreeGitDir = path.join(
			world.repo,
			".git",
			"worktrees",
			"widgets",
		);
		fs.mkdirSync(worktreeGitDir, { recursive: true });
		fs.writeFileSync(path.join(worktreeGitDir, "commondir"), "../..\n");
		fs.writeFileSync(
			path.join(worktreeGitDir, "HEAD"),
			"ref: refs/heads/codex/fix\n",
		);
		const worktree = path.join(
			world.home,
			".codex",
			"worktrees",
			"ab12",
			"widgets",
		);
		fs.mkdirSync(worktree, { recursive: true });
		fs.writeFileSync(
			path.join(worktree, ".git"),
			`gitdir: ${worktreeGitDir}\n`,
		);
		const goneWorktree = path.join(
			world.home,
			".codex",
			"worktrees",
			"cd34",
			"widgets",
		);
		const meta = (id: string, cwd: string, extra = {}) => ({
			timestamp: "t0",
			type: "session_meta",
			payload: { id, cwd, cli_version: "0.160.0", ...extra },
		});
		const prompt = {
			timestamp: "t1",
			type: "response_item",
			payload: {
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "hi" }],
			},
		};
		const live = writeJsonl(path.join(rollouts(), "rollout-a-live.jsonl"), [
			meta("live", worktree),
			prompt,
		]);
		const gone = writeJsonl(path.join(rollouts(), "rollout-b-gone.jsonl"), [
			meta("gone", goneWorktree, {
				git: { repository_url: "https://github.com/acme/widgets" },
			}),
			prompt,
		]);
		const unrelated = writeJsonl(
			path.join(rollouts(), "rollout-c-other.jsonl"),
			[
				meta(
					"other",
					path.join(world.home, ".codex", "worktrees", "ef56", "elsewhere"),
				),
				prompt,
			],
		);
		setMtime(live, 3_000_000);
		setMtime(gone, 2_000_000);
		setMtime(unrelated, 4_000_000);
		const refs = discoverCodexSessions(world.repo, world.home, 5);
		expect(refs.map((ref) => ref.id)).toEqual(["live", "gone"]);
		expect(gitIdentity(worktree)).toMatchObject({
			remote: "acme/widgets",
			branch: "codex/fix",
			root: worktree,
		});
	});
});

describe("latest session and the calling agent", () => {
	function claudeSession(id: string, mtime: number, empty = false) {
		const cwd = world.repo;
		const records = empty
			? [
					{ type: "summary", summary: "x", leafUuid: "u" },
					{ type: "file-history-snapshot", messageId: "m", snapshot: {}, cwd },
				]
			: claude21Records(cwd).map((record) => ({ ...record, sessionId: id }));
		const file = writeJsonl(claudeFile(world.home, cwd, id), records);
		setMtime(file, mtime);
		return file;
	}

	it("skips sessions with no user or assistant message", () => {
		claudeSession("has-messages", 1_000_000);
		claudeSession("empty-newer", 2_000_000, true);
		writeCursorAgentChat(world.home, world.repo, "cursor-empty", {
			messages: [{ role: "system", content: "sys" }],
			updatedAtMs: 3_000_000,
		});
		expect(findLatestSession(world.repo, { home: world.home })?.id).toBe(
			"has-messages",
		);
	});

	it("prefers the calling agent's own session, then its newest session", () => {
		claudeSession("claude-old", 1_000_000);
		writeCursorAgentChat(world.home, world.repo, "cursor-new", {
			updatedAtMs: 5_000_000,
		});
		const none = { ancestors: () => [] };
		expect(
			findSessionToImport(world.repo, { home: world.home, env: {}, ...none }),
		).toMatchObject({
			reason: "latest",
			ref: { id: "cursor-new" },
		});
		expect(
			findSessionToImport(world.repo, {
				home: world.home,
				env: { CLAUDECODE: "1" },
				...none,
			}),
		).toMatchObject({ reason: "caller-latest", ref: { id: "claude-old" } });
		expect(
			findSessionToImport(world.repo, {
				home: world.home,
				env: { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "claude-old" },
				...none,
			}),
		).toMatchObject({
			reason: "caller-session",
			ref: { tool: "claude", id: "claude-old" },
		});
		expect(
			findSessionToImport(world.repo, {
				home: world.home,
				env: { CURSOR_AGENT: "1", CURSOR_CONVERSATION_ID: "cursor-new" },
				...none,
			}),
		).toMatchObject({
			reason: "caller-session",
			ref: { tool: "cursor-agent" },
		});
	});

	it("detects agents from environment markers and breaks ties by the nearest ancestor", () => {
		const tool = (env: Record<string, string>) =>
			detectCallingAgent(env, { ancestors: () => [] })?.tool;
		expect(tool({ CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli" })).toBe(
			"claude",
		);
		expect(tool({ CODEX_THREAD_ID: "019a" })).toBe("codex");
		expect(tool({ CODEX_SANDBOX: "seatbelt" })).toBe("codex");
		expect(tool({ OPENCODE: "1", AGENT: "1" })).toBe("opencode");
		expect(tool({ PI_CODING_AGENT: "true" })).toBe("pi");
		expect(tool({ GROK_SESSION_ID: "g1" })).toBe("grok");
		expect(tool({ GEMINI_CLI: "1" })).toBe("gemini");
		expect(tool({ CURSOR_AGENT: "1" })).toBe("cursor-agent");
		expect(tool({ AI_AGENT: "claude-code_2-1-296_agent" })).toBe("claude");
		expect(tool({ TERM_PROGRAM: "vscode", CURSOR_TRACE_ID: "t" })).toBe(
			"cursor",
		);
		expect(
			tool({
				TERM_PROGRAM: "vscode",
				CURSOR_TRACE_ID: "t",
				CODEX_THREAD_ID: "x",
			}),
		).toBe("codex");
		expect(tool({})).toBeUndefined();
		expect(
			detectCallingAgent(
				{ CLAUDECODE: "1", CODEX_THREAD_ID: "x" },
				{ ancestors: () => ["codex", "claude"] },
			)?.tool,
		).toBe("codex");
		expect(
			agentsFromEnvironment({ PI_SESSION_FILE: "/p.jsonl" })[0],
		).toMatchObject({ tool: "pi", sessionFile: "/p.jsonl" });
	});

	it("trims the turns about the import itself", () => {
		const turn = (
			role: Turn["role"],
			text: string,
			at?: string,
			toolCalls: ToolCall[] = [],
		): Turn => ({ role, text, at, toolCalls });
		const shell = (command: string) =>
			createToolCall({ name: "Bash", input: { command } });
		const turns = [
			turn("user", "fix it", "2026-11-01T10:00:00Z"),
			turn("assistant", "fixed", "2026-11-01T10:01:00Z", [shell("npm test")]),
			turn("user", "now continue this in the cloud", "2026-11-01T10:02:00Z"),
			turn("assistant", "importing", "2026-11-01T10:02:05Z", [
				shell("npx ytimesy import --latest"),
			]),
			turn("user", "status?", "2026-11-01T10:03:00Z"),
		];
		expect(
			trimImportTail(turns, { command: "ytimesy import" }).map((t) => t.text),
		).toEqual(["fix it", "fixed"]);
		expect(
			trimImportTail(turns, { startedAt: "2026-11-01T10:02:05Z" }).map(
				(t) => t.text,
			),
		).toEqual(["fix it", "fixed", "now continue this in the cloud"]);
		const mixed = [
			turn("user", "go"),
			turn("assistant", "", undefined, [
				shell("ls"),
				shell("npx ytimesy import"),
				shell("pwd"),
			]),
		];
		expect(
			trimImportTail(mixed, { command: /ytimesy import/ })
				.at(-1)
				?.toolCalls.map((call) => call.command),
		).toEqual(["ls"]);
	});
});

describe("machine-wide discovery", () => {
	it("lists every tool's sessions with folder git identity, title, size and message counts", () => {
		fs.writeFileSync(
			path.join(world.repo, ".git", "config"),
			originConfig("https://github.com/acme/widgets.git"),
		);
		fs.writeFileSync(
			path.join(world.repo, ".git", "HEAD"),
			"ref: refs/heads/feature-x\n",
		);
		writeJsonl(
			claudeFile(world.home, world.repo, "c1"),
			claude21Records(world.repo),
		);
		const plain = path.join(world.home, "notes");
		fs.mkdirSync(plain, { recursive: true });
		writeCursorAgentChat(world.home, plain, "chat-plain");
		const project = geminiProject(world.home, world.repo, "repo");
		writeGeminiJsonl(
			project,
			"session-2026-10-30T10-00-gemsess1.jsonl",
			geminiJsonlRecords(world.repo),
		);
		const fixture = createCursorApp(world.home);
		bubbleComposer(fixture, "comp-bubbles", world.repo);
		addCursorWorkspace(fixture, "ws1", world.repo, ["comp-bubbles"]);

		const result = discoverAllSessions({ home: world.home });
		expect(Object.keys(result.errors)).toEqual([]);
		const byTool = Object.fromEntries(
			result.sessions.map((session) => [session.tool, session]),
		);
		expect(Object.keys(byTool).sort()).toEqual([
			"claude",
			"cursor",
			"cursor-agent",
			"gemini",
		]);
		expect(byTool.claude?.git).toEqual({
			root: world.repo,
			remote: "acme/widgets",
			remoteUrl: "https://github.com/acme/widgets.git",
			branch: "feature-x",
		});
		expect(byTool["cursor-agent"]?.git).toBe("none");
		expect(byTool.gemini).toMatchObject({
			title: "Fix failing app test",
			messageCount: 4,
			messageCountExact: true,
		});
		expect(byTool.cursor).toMatchObject({
			title: "Build fix",
			messageCount: 7,
			messageCountExact: true,
		});
		expect(byTool["cursor-agent"]?.messageCount).toBe(8);
		for (const session of result.sessions) {
			expect(session.sizeBytes).toBeGreaterThan(0);
			expect(
				readSession(session.ref, {}, world.home).turns.length,
			).toBeGreaterThan(0);
		}
		expect(result.timingsMs.cursor).toBeGreaterThanOrEqual(0);
	});

	it("normalizes remotes to owner/name for GitHub and host/path elsewhere", () => {
		expect(normalizeRemote("git@github.com:acme/widgets.git")).toBe(
			"acme/widgets",
		);
		expect(normalizeRemote("https://github.com/acme/widgets")).toBe(
			"acme/widgets",
		);
		expect(normalizeRemote("ssh://git@github.com/acme/widgets.git")).toBe(
			"acme/widgets",
		);
		expect(
			normalizeRemote("https://user:token@github.com/acme/widgets.git/"),
		).toBe("acme/widgets");
		expect(normalizeRemote("git@gitlab.com:group/sub/proj.git")).toBe(
			"gitlab.com/group/sub/proj",
		);
		expect(normalizeRemote("not a url")).toBeUndefined();
	});
});
