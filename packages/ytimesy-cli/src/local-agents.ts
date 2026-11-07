export const LOCAL_AGENTS = [
	"claude",
	"codex",
	"opencode",
	"pi",
	"grok",
	"gemini",
	"cursor",
] as const;
export type LocalAgent = (typeof LOCAL_AGENTS)[number];

export const LOCAL_AGENT_NAMES: Readonly<Record<LocalAgent, string>> = {
	claude: "Claude Code",
	codex: "Codex",
	opencode: "OpenCode",
	pi: "Pi",
	grok: "Grok",
	gemini: "Gemini CLI",
	cursor: "Cursor",
};
