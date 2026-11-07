import { CODE_MODE_TOOL } from "./code-mode";

export type SessionActivityGlyph =
	| "thinking"
	| "plan"
	| "shell"
	| "search"
	| "read"
	| "edit"
	| "files"
	| "web"
	| "mcp"
	| "error"
	| "tool"
	| "wait"
	| "message"
	| "image"
	| "guide"
	| "stop"
	| "test"
	| "switch"
	| "agent"
	| "browser"
	| "code"
	| "review"
	| "history"
	| "secret"
	| "notice";

/**
 * The icon of every tool the harness offers or records (lean shapes, the
 * shell surface, plan/secret/MCP/subagent tools, code mode, the review and
 * attempt loops) and of the retired tools older chats still hold. Names not
 * listed fall back to the heuristics below; session-activity.test.ts fails
 * when a harness tool is missing from this table or tool-detail.ts.
 */
const TOOL_GLYPHS: Readonly<Record<string, SessionActivityGlyph>> = {
	// Lean shapes (LEAN_SHAPE_TOOLS).
	bash: "shell",
	read: "read",
	write: "edit",
	edit: "edit",
	exec_command: "shell",
	write_stdin: "wait",
	apply_patch: "edit",
	view_image: "image",
	Bash: "shell",
	Read: "read",
	Write: "edit",
	Edit: "edit",
	Glob: "search",
	Grep: "search",
	run_shell_command: "shell",
	read_file: "read",
	write_file: "edit",
	replace: "edit",
	glob: "search",
	grep_search: "search",
	// The shell surface (BUILDER_SHELL_TOOLS).
	execute_command: "shell",
	continue_command: "wait",
	stop_command: "stop",
	read_environment_report: "guide",
	report_task_blocked: "message",
	check_deliverable: "test",
	read_context_archive: "history",
	search_context_history: "history",
	browser_open: "browser",
	browser_screenshot: "browser",
	browser_inspect: "browser",
	browser_execute: "browser",
	// Added per turn.
	web_search: "web",
	google_search: "web",
	read_plugin_skill: "guide",
	search_mcp_tools: "mcp",
	call_mcp_tool: "mcp",
	enter_plan_mode: "plan",
	propose_plan: "plan",
	request_project_secret: "secret",
	request_push_approval: "plan",
	ask_user: "plan",
	agent: "agent",
	agent_send: "agent",
	[CODE_MODE_TOOL]: "code",
	// Written by the review and attempt loops.
	review_check: "review",
	attempt_check: "review",
	// Retired tools still stored in older chats.
	read_files: "read",
	list_files: "search",
	search_files: "search",
	inspect_changes: "files",
	verify_changes: "test",
	run_checks: "test",
	create_file: "edit",
	replace_text: "edit",
	apply_patches: "edit",
	rename_symbol: "edit",
	rename_file: "edit",
	apply_code_action: "edit",
	start_command: "shell",
	read_command: "wait",
	wait_command: "wait",
	read_tool_output: "read",
	compose_tools: "code",
	update_plan: "plan",
	read_work_plan: "plan",
	plan_parallel_work: "plan",
	remember_project: "guide",
	inspect_project_evidence: "guide",
	read_repository_guidance: "guide",
	search_tools: "search",
	browser_click: "browser",
	browser_type: "browser",
	browser_key: "browser",
	inspect_code: "read",
	inspect_code_batch: "read",
	read_code: "read",
	debug_program: "shell",
	debug_node: "shell",
	prepare_code_tools: "code",
	read_task_checks: "agent",
	read_task_summary: "agent",
	read_task_output: "agent",
	read_task_capacity: "agent",
	list_peers: "agent",
	send_peer_message: "agent",
	create_task: "agent",
	edit_task: "agent",
	start_task: "agent",
	list_tasks: "agent",
	send_task_message: "agent",
	request_task_wrap_up: "agent",
	inspect_task_diff: "agent",
	read_task_handoff: "agent",
	import_reviewed_task: "agent",
	mark_task_reviewed: "agent",
	publish_task: "agent",
};

/** Whether a tool has its own icon (not the heuristic fallback). */
export function hasToolGlyph(tool: string): boolean {
	return Object.hasOwn(TOOL_GLYPHS, tool) || tool.startsWith("mcp__");
}

const SEARCH_TOOLS = new Set([
	"grep",
	"rg",
	"glob",
	"search",
	"codebase_search",
	"semantic_search",
	"search_code",
]);

const READ_TOOLS = new Set(["read_file", "read", "cat", "view", "open"]);

const EDIT_TOOLS = new Set([
	"apply_patch",
	"write_file",
	"write",
	"edit",
	"str_replace",
	"search_replace",
	"create_file",
	"delete_file",
]);

const SHELL_TOOLS = new Set(["shell", "bash", "zsh", "command", "exec"]);

const WEB_TOOLS = new Set(["web_search", "web_fetch", "websearch", "fetch"]);

function toolKey(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[\s-]+/g, "_");
}

export function activityGlyphForToolName(tool: string): SessionActivityGlyph {
	const known = Object.hasOwn(TOOL_GLYPHS, tool) ? TOOL_GLYPHS[tool] : null;
	if (known) return known;
	// MCP tools keep one icon, whatever their name says (search_issues is not a code search).
	if (tool.startsWith("mcp__")) return "mcp";
	const key = toolKey(tool);
	if (WEB_TOOLS.has(key) || key.startsWith("web_")) return "web";
	if (EDIT_TOOLS.has(key)) return "edit";
	if (READ_TOOLS.has(key) || key.startsWith("read")) return "read";
	if (SHELL_TOOLS.has(key)) return "shell";
	if (SEARCH_TOOLS.has(key)) return "search";
	if (key.includes("web")) return "web";
	if (key.includes("patch") || key.includes("write") || key.includes("edit")) {
		return "edit";
	}
	if (key.includes("shell") || key.includes("command")) return "shell";
	if (key.includes("grep") || key.includes("search")) return "search";
	return "tool";
}
