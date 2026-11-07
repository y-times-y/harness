/** `cursor-agent` is the Cursor CLI; `cursor` is the Cursor app (editor agent / composer chats). */
export type AgentTool =
	| "claude"
	| "codex"
	| "opencode"
	| "pi"
	| "grok"
	| "gemini"
	| "cursor-agent"
	| "cursor";

export const AGENT_TOOLS: readonly AgentTool[] = [
	"claude",
	"codex",
	"opencode",
	"pi",
	"grok",
	"gemini",
	"cursor-agent",
	"cursor",
];

export type ToolCallKind =
	| "shell"
	| "edit"
	| "write"
	| "read"
	| "search"
	| "other";

export interface ToolCall {
	kind: ToolCallKind;
	name: string;
	/** Raw tool input as JSON text (or patch / script text), truncated. */
	input: string;
	/** The shell command line, set only for `kind: "shell"`. */
	command?: string;
	/** Tool output, truncated to MAX_TOOL_OUTPUT_CHARS. */
	output?: string;
	exitCode?: number;
	isError?: boolean;
	/** Paths the call names in its input (files read, edited, written or searched). */
	paths: string[];
	/** Paths the call is known to have changed on disk, e.g. a shell `sed -i` or an apply_patch. */
	changedPaths: string[];
}

/**
 * `compaction-summary`: the source agent's own summary of earlier context.
 * `trim-digest`: a rule-based digest of turns dropped by trimToBudget.
 */
export type SyntheticTurnKind = "compaction-summary" | "trim-digest";

export interface Turn {
	role: "user" | "assistant";
	text: string;
	/** ISO timestamp of the first event of the turn, when the source records one. */
	at?: string;
	toolCalls: ToolCall[];
	synthetic?: SyntheticTurnKind;
}

/** Enough to locate and read one session; produced by discovery without parsing transcripts. */
export interface SessionRef {
	tool: AgentTool;
	id: string;
	cwd: string;
	/** Unix ms, from file mtime or the store's own update time. */
	updatedAt: number;
	/** Transcript file (JSONL tools), the session directory (Grok) or the SQLite db (OpenCode). */
	location: string;
}

export interface LocalSession {
	tool: AgentTool;
	id: string;
	cwd: string;
	gitBranch?: string;
	model?: string;
	startedAt?: string;
	updatedAt: number;
	title?: string;
	cliVersion?: string;
	turns: Turn[];
	/**
	 * False when a budgeted read stopped before the start of the transcript
	 * (older turns were not read). A compaction summary, when present, covers them.
	 */
	readFromStart: boolean;
	/** Lines (or rows) that were read but could not be parsed; they are skipped. */
	unparsedRecords: number;
	/**
	 * Set when the store is in a shape this reader does not recognize (for example a
	 * newer private Cursor format); `turns` is then empty rather than guessed.
	 */
	unsupported?: string;
}

export interface ReadOptions {
	/**
	 * Approximate character budget for turns. Readers of large transcripts read
	 * backwards from the end and stop once this much content (plus slack) is
	 * collected or a source compaction summary is reached. Omit to read everything.
	 */
	budgetChars?: number;
}

/** Reader-internal options; activityOnly is used by readSessionActivity. */
export interface ReaderOptions extends ReadOptions {
	/** Whole-file pass over tool calls and results only; turns carry no text. */
	activityOnly?: boolean;
}
