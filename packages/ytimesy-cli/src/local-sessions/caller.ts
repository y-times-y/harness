/**
 * Which coding agent is running us, from the environment it gives its shell commands,
 * and the session the import should come from.
 *
 * Markers (how each was checked):
 * - Claude Code: `CLAUDECODE=1`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ID` (the
 *   transcript id), `AI_AGENT=claude-code_<version>_agent`. Seen live in Claude Code 2.1.296.
 * - Codex: `CODEX_THREAD_ID` (the rollout id; exported to tool shells), `CODEX_SANDBOX`,
 *   `CODEX_SANDBOX_NETWORK_DISABLED`, `CODEX_CI`. From the codex-cli 0.161.0 binary.
 * - OpenCode: `OPENCODE=1`, `OPENCODE_PID`, `AGENT=1`. From the OpenCode binary (set at start).
 * - Pi: `PI_CODING_AGENT=true`, `AI_AGENT=pi...`, `PI_SESSION_ID` / `PI_SESSION_FILE` (when
 *   the session environment is exposed). From the pi-coding-agent package source.
 * - Grok: `GROK_SESSION_ID`. From the Grok binary, where it is set for hooks and MCP
 *   servers; whether shell commands get it is not verified.
 * - Gemini CLI: `GEMINI_CLI=1` in shell-tool commands (no session id). From the 0.40.1 bundle.
 * - Cursor CLI and Cursor app agent: `CURSOR_AGENT=1`, `CURSOR_CONVERSATION_ID` (the chat /
 *   composer id with `%` replaced by `_`), `CURSOR_REQUEST_ID`. From the cursor-agent
 *   2026.10.01 bundle; the app runs the same agent runtime. The id says which store holds it.
 * - `TERM_PROGRAM=vscode` with `CURSOR_TRACE_ID` only means a Cursor terminal (a weak hint).
 * When markers of several agents are present (one agent started inside another), the
 * nearest agent process among our ancestors decides.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeProjectsDirectory, claudeSessionRefForFile } from "./claude.ts";
import {
	codexSessionRefForFile,
	codexSessionsDirectory,
	listCodexRolloutFiles,
} from "./codex.ts";
import {
	cursorAgentSessionRefForDirectory,
	cursorChatsDirectory,
	openSqliteReadOnly,
} from "./cursor-agent.ts";
import { cursorUserDirectories, listCursorComposers } from "./cursor-app.ts";
import { grokSessionRefForDirectory, grokSessionsDirectory } from "./grok.ts";
import { listDirectory } from "./io.ts";
import { piSessionRefForFile } from "./pi.ts";
import type { AgentTool, SessionRef, ToolCall, Turn } from "./types.ts";

export interface CallingAgent {
	tool: AgentTool;
	/** The caller's own session id, when its environment names it. */
	sessionId?: string;
	/** The caller's session file, when its environment names it (Pi). */
	sessionFile?: string;
	/** Environment variables that identified it. */
	evidence: string[];
	/** True when only weak hints matched (a Cursor terminal, a generic AI_AGENT value). */
	weak?: boolean;
}

type Env = Record<string, string | undefined>;

const set = (env: Env, key: string) => {
	const value = env[key];
	return value !== undefined && value.trim() !== "";
};

const AI_AGENT_PREFIXES: [RegExp, AgentTool][] = [
	[/^claude[-_]?code/i, "claude"],
	[/^codex/i, "codex"],
	[/^opencode/i, "opencode"],
	[/^pi\b|^pi[-_]/i, "pi"],
	[/^gemini/i, "gemini"],
	[/^cursor/i, "cursor-agent"],
	[/^grok/i, "grok"],
];

/** Every agent whose markers are present, strongest evidence first. */
export function agentsFromEnvironment(env: Env): CallingAgent[] {
	const found: CallingAgent[] = [];
	const add = (agent: CallingAgent) => {
		if (agent.evidence.length > 0) found.push(agent);
	};
	add({
		tool: "claude",
		sessionId: env.CLAUDE_CODE_SESSION_ID?.trim() || undefined,
		evidence: [
			"CLAUDECODE",
			"CLAUDE_CODE_ENTRYPOINT",
			"CLAUDE_CODE_SESSION_ID",
		].filter((key) => set(env, key)),
	});
	add({
		tool: "codex",
		sessionId: env.CODEX_THREAD_ID?.trim() || undefined,
		evidence: [
			"CODEX_THREAD_ID",
			"CODEX_SANDBOX",
			"CODEX_SANDBOX_NETWORK_DISABLED",
			"CODEX_CI",
		].filter((key) => set(env, key)),
	});
	add({
		tool: "opencode",
		evidence: ["OPENCODE", "OPENCODE_PID"].filter((key) => set(env, key)),
	});
	add({
		tool: "pi",
		sessionId: env.PI_SESSION_ID?.trim() || undefined,
		sessionFile: env.PI_SESSION_FILE?.trim() || undefined,
		evidence: ["PI_CODING_AGENT", "PI_SESSION_ID", "PI_SESSION_FILE"].filter(
			(key) => set(env, key),
		),
	});
	add({
		tool: "grok",
		sessionId: env.GROK_SESSION_ID?.trim() || undefined,
		evidence: ["GROK_SESSION_ID"].filter((key) => set(env, key)),
	});
	add({
		tool: "gemini",
		evidence: env.GEMINI_CLI === "1" ? ["GEMINI_CLI"] : [],
	});
	add({
		tool: "cursor-agent",
		sessionId: env.CURSOR_CONVERSATION_ID?.trim() || undefined,
		evidence: ["CURSOR_AGENT", "CURSOR_CONVERSATION_ID"].filter((key) =>
			set(env, key),
		),
	});
	const aiAgent = env.AI_AGENT?.trim();
	if (aiAgent) {
		const tool = AI_AGENT_PREFIXES.find(([pattern]) =>
			pattern.test(aiAgent),
		)?.[1];
		const existing = found.find((agent) => agent.tool === tool);
		if (existing) existing.evidence.push("AI_AGENT");
		else if (tool) found.push({ tool, evidence: ["AI_AGENT"], weak: true });
	}
	if (
		found.length === 0 &&
		env.TERM_PROGRAM === "vscode" &&
		set(env, "CURSOR_TRACE_ID")
	)
		found.push({
			tool: "cursor",
			evidence: ["TERM_PROGRAM", "CURSOR_TRACE_ID"],
			weak: true,
		});
	return found;
}

const PROCESS_PATTERNS: [RegExp, AgentTool][] = [
	[/(^|\/)claude(\s|$)|@anthropic-ai\/claude-code/, "claude"],
	[/(^|\/)codex(\s|$)|codex-[a-z0-9-]+\/vendor\/.*\/codex/, "codex"],
	[/(^|\/)opencode(\.exe)?(\s|$)/, "opencode"],
	[/(^|\/)pi(\s|$)|pi-coding-agent/, "pi"],
	[/(^|\/)grok(-native)?(\s|$)/, "grok"],
	[/gemini-cli|(^|\/)gemini(\s|$)/, "gemini"],
	[/cursor-agent|(^|\/)agent(\s|$)/, "cursor-agent"],
	[/Cursor Helper|Cursor\.app|cursor-agent-worker/, "cursor"],
];

/** Agent tools among our ancestor processes, nearest first (POSIX `ps`; empty elsewhere). */
export function agentAncestors(maxDepth = 24): AgentTool[] {
	if (process.platform === "win32") return [];
	const tools: AgentTool[] = [];
	let pid = process.ppid;
	for (let depth = 0; depth < maxDepth && pid > 1; depth++) {
		let line: string;
		try {
			line = execFileSync("ps", ["-o", "ppid=,command=", "-p", String(pid)], {
				encoding: "utf8",
				timeout: 2000,
			}).trim();
		} catch {
			break;
		}
		const match = /^(\d+)\s+(.*)$/.exec(line);
		if (!match) break;
		const command = match[2] ?? "";
		const tool = PROCESS_PATTERNS.find(([pattern]) =>
			pattern.test(command),
		)?.[1];
		if (tool && !tools.includes(tool)) tools.push(tool);
		pid = Number(match[1]);
	}
	return tools;
}

export interface DetectOptions {
	/** Ancestor agent tools, nearest first; defaults to a `ps` walk when needed. */
	ancestors?: () => AgentTool[];
}

/**
 * The agent that is calling us, or undefined. With markers of more than one agent the
 * nearest agent ancestor process wins; otherwise the strongest marker does.
 */
export function detectCallingAgent(
	env: Env = process.env,
	options: DetectOptions = {},
): CallingAgent | undefined {
	const found = agentsFromEnvironment(env);
	const strong = found.filter((agent) => !agent.weak);
	const pool = strong.length > 0 ? strong : found;
	if (pool.length <= 1) return pool[0];
	const ancestors = (options.ancestors ?? agentAncestors)();
	for (const tool of ancestors) {
		const match = pool.find(
			(agent) =>
				agent.tool === tool ||
				(tool === "cursor" && agent.tool === "cursor-agent"),
		);
		if (match) return match;
	}
	return pool[0];
}

/** Locates a session by its tool and id with directory listings (no transcript reads). */
export function findSessionById(
	agent: Pick<CallingAgent, "tool" | "sessionId" | "sessionFile">,
	home = os.homedir(),
): SessionRef | undefined {
	const id = agent.sessionId;
	switch (agent.tool) {
		case "claude": {
			if (!id) return undefined;
			const projects = claudeProjectsDirectory(home);
			for (const project of listDirectory(projects)) {
				const file = path.join(projects, project.name, `${id}.jsonl`);
				if (fs.existsSync(file)) return claudeSessionRefForFile(file);
			}
			return undefined;
		}
		case "codex": {
			if (!id) return undefined;
			const hit = listCodexRolloutFiles(codexSessionsDirectory(home)).find(
				({ file }) => path.basename(file).includes(id),
			);
			return hit ? codexSessionRefForFile(hit.file, hit.mtime) : undefined;
		}
		case "pi":
			return agent.sessionFile && fs.existsSync(agent.sessionFile)
				? piSessionRefForFile(agent.sessionFile)
				: undefined;
		case "grok": {
			if (!id) return undefined;
			const root = grokSessionsDirectory(home);
			for (const cwd of listDirectory(root)) {
				const directory = path.join(root, cwd.name, id);
				if (fs.existsSync(directory))
					return grokSessionRefForDirectory(directory);
			}
			return undefined;
		}
		case "cursor-agent":
		case "cursor": {
			if (!id) return undefined;
			const chats = cursorChatsDirectory(home);
			for (const folder of listDirectory(chats)) {
				const directory = path.join(chats, folder.name, id);
				if (fs.existsSync(path.join(directory, "store.db")))
					return cursorAgentSessionRefForDirectory(directory);
			}
			for (const userDirectory of cursorUserDirectories(home)) {
				const stateFile = path.join(
					userDirectory,
					"globalStorage",
					"state.vscdb",
				);
				const database = openSqliteReadOnly(stateFile);
				let exists = false;
				try {
					exists = !!database
						?.prepare("SELECT 1 AS found FROM cursorDiskKV WHERE key = ?")
						.get(`composerData:${id}`);
				} catch {
					exists = false;
				} finally {
					database?.close();
				}
				if (!exists) continue;
				const composer = listCursorComposers(userDirectory, {
					folderFilter: () => true,
				}).composers.find((candidate) => candidate.composerId === id);
				return {
					tool: "cursor",
					id,
					cwd: composer?.folder ?? "",
					updatedAt: composer?.updatedAt ?? Date.now(),
					location: stateFile,
				};
			}
			return undefined;
		}
		default:
			return undefined;
	}
}

export interface ImportTailOptions {
	/** When the import command started (ms or ISO); turns stamped at or after it are dropped. */
	startedAt?: number | string;
	/** Matches the import command line (a regex, or a substring). */
	command?: RegExp | string;
}

function callMatches(call: ToolCall, command: RegExp | string): boolean {
	const text = call.command ?? call.input;
	return typeof command === "string"
		? text.includes(command)
		: command.test(text);
}

/**
 * Removes the end of the conversation that is about the import itself: turns stamped
 * at or after `startedAt`, and the newest tool call running the import command with
 * everything after it. When that leaves the assistant turn empty it is dropped, and so
 * is the user request right before it (the request to import).
 */
export function trimImportTail(
	turns: Turn[],
	options: ImportTailOptions,
): Turn[] {
	let result = turns.map((turn) => ({
		...turn,
		toolCalls: [...turn.toolCalls],
	}));
	if (options.startedAt !== undefined) {
		const cutoff =
			typeof options.startedAt === "number"
				? options.startedAt
				: Date.parse(options.startedAt);
		if (Number.isFinite(cutoff)) {
			const index = result.findIndex((turn) => {
				const at = turn.at ? Date.parse(turn.at) : Number.NaN;
				return Number.isFinite(at) && at >= cutoff && !turn.synthetic;
			});
			if (index !== -1) result = result.slice(0, index);
		}
	}
	if (options.command !== undefined) {
		for (let turnIndex = result.length - 1; turnIndex >= 0; turnIndex--) {
			const turn = result[turnIndex] as Turn;
			let callIndex = -1;
			for (let index = turn.toolCalls.length - 1; index >= 0; index--) {
				if (callMatches(turn.toolCalls[index] as ToolCall, options.command)) {
					callIndex = index;
					break;
				}
			}
			if (callIndex === -1) continue;
			const kept = turn.toolCalls.slice(0, callIndex);
			result = result.slice(0, turnIndex);
			if (kept.length > 0) {
				result.push({ ...turn, toolCalls: kept });
			} else if (result.at(-1)?.role === "user" && !result.at(-1)?.synthetic) {
				result.pop();
			}
			break;
		}
	}
	return result;
}
