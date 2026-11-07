/**
 * Reads local coding-agent sessions (Claude Code, Codex, OpenCode, Pi, Grok, Gemini CLI,
 * Cursor CLI, Cursor app) into one normalized model, for handing a local session off to
 * the cloud agent. Pure Node.
 */
import os from "node:os";
import {
	type CallingAgent,
	type DetectOptions,
	detectCallingAgent,
	findSessionById,
} from "./caller.ts";
import { discoverClaudeSessions, readClaudeSession } from "./claude.ts";
import { discoverCodexSessions, readCodexSession } from "./codex.ts";
import {
	discoverCursorAgentSessions,
	readCursorAgentSession,
} from "./cursor-agent.ts";
import { discoverCursorSessions, readCursorSession } from "./cursor-app.ts";
import { discoverGeminiSessions, readGeminiSession } from "./gemini.ts";
import { discoverGrokSessions, readGrokSession } from "./grok.ts";
import {
	successfulCommands,
	type TouchedFiles,
	touchedFiles,
} from "./handoff-helpers.ts";
import { canonicalPath, findGitRoot } from "./io.ts";
import { discoverOpencodeSessions, readOpencodeSession } from "./opencode.ts";
import { discoverPiSessions, readPiSession } from "./pi.ts";
import {
	AGENT_TOOLS,
	type AgentTool,
	type LocalSession,
	type ReadOptions,
	type SessionRef,
} from "./types.ts";

export type { TouchedFiles } from "./handoff-helpers.ts";
export {
	digestDroppedTurns,
	redact,
	successfulCommands,
	touchedFiles,
	trimToBudget,
	turnChars,
} from "./handoff-helpers.ts";
export * from "./types.ts";

export interface DiscoveryOptions {
	/** Defaults to the current user's home directory (tests point this at a fixture). */
	home?: string;
	/** Defaults to every supported tool. */
	tools?: readonly AgentTool[];
	/** Newest candidates kept per tool (per project folder for Claude and Pi); default 1. */
	perToolLimit?: number;
}

const discoverers: Record<
	AgentTool,
	(root: string, home: string, limit: number) => SessionRef[]
> = {
	claude: discoverClaudeSessions,
	codex: discoverCodexSessions,
	opencode: discoverOpencodeSessions,
	pi: discoverPiSessions,
	grok: discoverGrokSessions,
	gemini: discoverGeminiSessions,
	"cursor-agent": discoverCursorAgentSessions,
	cursor: discoverCursorSessions,
};

/** Candidates per tool looked at when the newest ones turn out to be empty. */
const EMPTY_SKIP_CANDIDATES = 5;

/** The git work tree root containing `repoPath`, or the path itself when it is not in a repo. */
export function resolveRepositoryRoot(repoPath: string): string {
	return findGitRoot(repoPath) ?? canonicalPath(repoPath);
}

/**
 * Candidate sessions per tool whose cwd is the repository root or inside it, newest
 * first. Uses directory listings, file mtimes and transcript first lines only.
 */
export function discoverSessions(
	repoPath: string,
	options: DiscoveryOptions = {},
): SessionRef[] {
	const root = resolveRepositoryRoot(repoPath);
	const home = options.home ?? os.homedir();
	const refs: SessionRef[] = [];
	for (const tool of options.tools ?? AGENT_TOOLS) {
		try {
			refs.push(...discoverers[tool](root, home, options.perToolLimit ?? 1));
		} catch {
			// One unreadable store must not hide sessions from the others.
		}
	}
	return refs.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Whether a session has at least one user or assistant message (a turn with text or a
 * tool call). Reads only the end of large transcripts.
 */
export function sessionHasMessages(
	ref: SessionRef,
	home = os.homedir(),
): boolean {
	try {
		const session = readSession(ref, { budgetChars: 4000 }, home);
		return (
			!session.unsupported &&
			session.turns.some(
				(turn) =>
					!turn.synthetic &&
					(turn.text.trim().length > 0 || turn.toolCalls.length > 0),
			)
		);
	} catch {
		return false;
	}
}

/**
 * The most recently updated session, across all tools, for the repository containing
 * `repoPath`; sessions with no user or assistant message are skipped.
 */
export function findLatestSession(
	repoPath: string,
	options: DiscoveryOptions = {},
): SessionRef | undefined {
	const home = options.home ?? os.homedir();
	return discoverSessions(repoPath, {
		...options,
		perToolLimit: options.perToolLimit ?? EMPTY_SKIP_CANDIDATES,
	}).find((ref) => sessionHasMessages(ref, home));
}

export interface ImportSelection {
	ref: SessionRef;
	/** The agent running us, when detected. */
	caller?: CallingAgent;
	/** `caller-session`: the caller's own session by id; `caller-latest`: its newest
	 * session in the repo; `latest`: newest session of any tool. */
	reason: "caller-session" | "caller-latest" | "latest";
}

export interface ImportSelectionOptions
	extends DiscoveryOptions,
		DetectOptions {
	/** Defaults to process.env. */
	env?: Record<string, string | undefined>;
}

/**
 * The session to import: the calling agent's own session when its environment names
 * it, else that agent's newest non-empty session in the repo, else the newest
 * non-empty session of any tool.
 */
export function findSessionToImport(
	repoPath: string,
	options: ImportSelectionOptions = {},
): ImportSelection | undefined {
	const home = options.home ?? os.homedir();
	const caller = detectCallingAgent(options.env ?? process.env, options);
	const allowed = (tool: AgentTool) =>
		!options.tools || options.tools.includes(tool);
	if (
		caller &&
		allowed(caller.tool) &&
		(caller.sessionId || caller.sessionFile)
	) {
		const ref = findSessionById(caller, home);
		if (ref && allowed(ref.tool))
			return { ref, caller, reason: "caller-session" };
	}
	const candidates = discoverSessions(repoPath, {
		...options,
		perToolLimit: options.perToolLimit ?? EMPTY_SKIP_CANDIDATES,
	});
	if (caller) {
		const sameTool = (tool: AgentTool) =>
			tool === caller.tool ||
			(caller.tool.startsWith("cursor") && tool.startsWith("cursor"));
		const ref = candidates.find(
			(candidate) =>
				sameTool(candidate.tool) && sessionHasMessages(candidate, home),
		);
		if (ref) return { ref, caller, reason: "caller-latest" };
	}
	const ref = candidates.find((candidate) =>
		sessionHasMessages(candidate, home),
	);
	return ref ? { ref, caller, reason: "latest" } : undefined;
}

/**
 * Reads a session's conversation. With `budgetChars`, large transcripts are read
 * backwards from the end only as far as needed; pass the result through
 * trimToBudget for the final cut.
 */
export function readSession(
	ref: SessionRef,
	options: ReadOptions = {},
	home = os.homedir(),
): LocalSession {
	switch (ref.tool) {
		case "claude":
			return readClaudeSession(ref, options);
		case "codex":
			return readCodexSession(ref, options);
		case "opencode":
			return readOpencodeSession(ref, options, home);
		case "pi":
			return readPiSession(ref, options);
		case "grok":
			return readGrokSession(ref, options);
		case "gemini":
			return readGeminiSession(ref, options);
		case "cursor-agent":
			return readCursorAgentSession(ref, options);
		case "cursor":
			return readCursorSession(ref, options);
	}
}

export interface SessionActivity {
	/** Shell commands that exited 0, in first-run order. */
	successfulCommands: string[];
	files: TouchedFiles;
	toolCallCount: number;
}

/**
 * One forward pass over the whole session that parses only tool call / result
 * records and keeps only commands and paths. Independent of readSession, so a
 * caller can run both in parallel.
 */
export function readSessionActivity(
	ref: SessionRef,
	options: { root?: string; home?: string } = {},
): SessionActivity {
	const session = (() => {
		switch (ref.tool) {
			case "claude":
				return readClaudeSession(ref, { activityOnly: true });
			case "codex":
				return readCodexSession(ref, { activityOnly: true });
			case "opencode":
				return readOpencodeSession(
					ref,
					{ activityOnly: true },
					options.home ?? os.homedir(),
				);
			case "pi":
				return readPiSession(ref, { activityOnly: true });
			case "grok":
				return readGrokSession(ref, { activityOnly: true });
			case "gemini":
				return readGeminiSession(ref, { activityOnly: true });
			case "cursor-agent":
				return readCursorAgentSession(ref, { activityOnly: true });
			case "cursor":
				return readCursorSession(ref, { activityOnly: true });
		}
	})();
	return {
		successfulCommands: successfulCommands(session),
		files: touchedFiles(session, {
			root: options.root ?? resolveRepositoryRoot(session.cwd),
		}),
		toolCallCount: session.turns.reduce(
			(sum, turn) => sum + turn.toolCalls.length,
			0,
		),
	};
}

export {
	agentsFromEnvironment,
	type CallingAgent,
	detectCallingAgent,
	findSessionById,
	type ImportTailOptions,
	trimImportTail,
} from "./caller.ts";
export { claudeProjectsDirectory, claudeSessionRefForFile } from "./claude.ts";
export {
	codexSessionRefForFile,
	codexSessionsDirectory,
	listCodexRolloutFiles,
} from "./codex.ts";
export {
	cursorAgentSessionRefForDirectory,
	cursorChatsDirectory,
	listCursorAgentSessionRefs,
} from "./cursor-agent.ts";
export {
	cursorUserDirectories,
	listCursorComposers,
	listCursorSessionRefs,
} from "./cursor-app.ts";
export {
	exportFullTranscript,
	type FullTranscriptOptions,
	type FullTranscriptResult,
} from "./full-transcript.ts";
export {
	geminiCheckpointRef,
	geminiTempDirectory,
	listGeminiSessionRefs,
} from "./gemini.ts";
export { type GitIdentity, gitIdentity, normalizeRemote } from "./git.ts";
export { grokSessionRefForDirectory, grokSessionsDirectory } from "./grok.ts";
export {
	discoverAllSessions,
	type FolderGit,
	type MachineDiscovery,
	type MachineSession,
} from "./machine.ts";
export { listOpencodeSessionRefs } from "./opencode.ts";
export { piSessionRefForFile, piSessionsDirectory } from "./pi.ts";
