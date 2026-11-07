import { CODE_MODE_TOOL, codeModeCallItems, codeModeResult } from "./code-mode";
import { commandActivityTitle } from "./command-activity-title";
import { leanToolRole } from "./harness-model-profile";
import { mcpCallName } from "./mcp-call-view";
import { redactSecrets } from "./project-workspace";
import type { SessionActivityGlyph } from "./session-activity";
import type { DynamicToolCallItem } from "./session-item";

export function toolCommand(item: DynamicToolCallItem): string | null {
	if (!item.input) return null;
	try {
		const input = JSON.parse(item.input);
		// The "codex" shape's exec_command names it cmd.
		const command = input.command ?? input.cmd;
		return typeof command === "string" ? command : null;
	} catch {
		return null;
	}
}

export function toolOutputText(output: string): string {
	try {
		let value = JSON.parse(output);
		if (value?.type === "text" && typeof value.value === "string")
			return value.value;
		if (value?.type === "json") value = value.value;
		if (typeof value?.stdout === "string" || typeof value?.stderr === "string")
			return [
				value.stdout,
				value.stderr,
				typeof value.exitCode === "number" ? `exit ${value.exitCode}` : null,
			]
				.filter(Boolean)
				.join("\n");
		// A lean command result (lean-tools.ts): the shown output and its status.
		if (typeof value?.output === "string" && "outputPath" in value)
			return [
				value.output,
				value.truncationNote,
				typeof value.status === "number"
					? `exit ${value.status}`
					: value.status === "running"
						? `running (${value.id})`
						: value.status,
			]
				.filter(Boolean)
				.join("\n");
		return JSON.stringify(value, null, 2) ?? output;
	} catch {
		return output;
	}
}

export function toolDetailTitle(item: DynamicToolCallItem): string {
	const name = item.tool.replaceAll("_", " ");
	if (!item.input) return name;
	try {
		const input = JSON.parse(item.input);
		const command = input.command ?? input.cmd;
		if (typeof command === "string") return commandActivityTitle(command);
		const detail =
			input.path ??
			input.file_path ??
			input.query ??
			input.pattern ??
			input.title;
		return typeof detail === "string"
			? `${name} · ${detail.replace(/\s+/g, " ").slice(0, 100)}`
			: name;
	} catch {
		return name;
	}
}

/** Public tool evidence is bounded and never includes credential-shaped fields. */
export function publicToolDetail(
	value: unknown,
	format: "structured" | "output" = "structured",
): string {
	const text =
		typeof value === "string"
			? value
			: (JSON.stringify(
					value,
					(key, entry) =>
						/^(authorization|cookie|password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)$/i.test(
							key,
						)
							? "[redacted]"
							: entry,
					2,
				) ?? "No output");
	const safe = redactSecrets(format === "output" ? toolOutputText(text) : text)
		.replace(/\bsk-[\w-]{12,}/g, "[redacted]")
		.replace(/\bAIza[\w-]{20,}/g, "[redacted]")
		// Google's newer key format (AQ. and an opaque token).
		.replace(/\bAQ\.[\w-]{30,}/g, "[redacted]")
		.replace(
			/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)["']?\s*[:=]\s*)(["'])(.*?)\2/gi,
			"$1$2[redacted]$2",
		)
		.replace(
			/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)["']?\s*[:=]\s*)(?!["'])[^\s,"'}]+/gi,
			"$1[redacted]",
		);
	return safe.length > 16000
		? `${safe.slice(0, 16000)}\n[Output truncated for display]`
		: safe;
}

/** A tool row as a short sentence: "Ran `make test`", "Edited lsm_db.h +12 −3". */
type ToolActivity = {
	verb: string;
	target?: string;
	/** Commands and paths render in monospace. */
	code?: boolean;
	added?: number;
	removed?: number;
	note?: string;
	/** Overrides the tool's own icon (activityGlyphForToolName). */
	glyph?: SessionActivityGlyph;
	/** No case knows this tool: the label is its name in words. */
	fallback?: true;
	/** A command left running in the background (ytimesy-job). */
	background?: true;
	/** An MCP call: verb is the server, target the tool; the card shows the server's icon. */
	mcpServer?: string;
};

/** What a command mostly does, for its icon. */
function commandGlyph(display: string): ToolActivity["glyph"] {
	const first = display.split(" · ")[0] ?? "";
	if (
		/\b(?:make\s+(?:-C\s+\S+\s+)?(?:test|check)|pytest|vitest|jest|cargo test|go test|npm (?:run )?test|pnpm (?:run )?test|bun test|ctest)\b/.test(
			display,
		)
	)
		return "test";
	if (/^(?:rg|grep|find|ls|fd)\b/.test(first)) return "search";
	if (/^(?:cat|sed|head|tail|wc|less|nl|for \w+ in)\b/.test(first))
		return "read";
	return undefined;
}

const basename = (path: string) =>
	path.split("/").filter(Boolean).at(-1) ?? path;
const clip = (text: string, length = 90) => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
};

/** The command a person would recognize: drop cd/set -e preambles, name heredoc scripts. */
export function displayCommand(command: string): string {
	let text = command.trim();
	for (;;) {
		const next = text
			.replace(/^set -[a-z]+\s*(?:\n|;|&&)\s*/i, "")
			.replace(/^cd\s+\S+\s*(?:&&|;|\n)\s*/, "")
			.replace(/^(?:[A-Z_][A-Z0-9_]*=\S*\s+)+/, "");
		if (next === text) break;
		text = next;
	}
	const heredoc =
		/^(\S*python\S*|node|bash|sh|ruby|perl)\b[^\n]*<<-?\s*'?(\w+)'?/.exec(text);
	if (heredoc) {
		const lines = text.split("\n").length - 2;
		return `${basename(heredoc[1])} script · ${Math.max(1, lines)} lines`;
	}
	// Compound commands: keep the parts that do something, drop separators and
	// orientation noise, so similar-looking rows differ by what they ran.
	const parts = text
		.split(/\s*(?:&&|\|\||;|\n)\s*/)
		.map((part) => part.trim())
		.filter(
			(part) =>
				part &&
				!/^(?:pwd|true|:|set -[a-z]+|cd\s+\S+|git status(?: --short| -s)?|printf\s+['"].*|echo\s+['"]?-{2,}.*|[a-z_]+_status=\$\?)$/i.test(
					part,
				),
		);
	return clip(
		(parts.length ? parts : [text.split("\n")[0]]).slice(0, 3).join(" · "),
	);
}

/** Lines in an edit's text, for a card's +/− counts. */
function lineCount(value: unknown) {
	if (typeof value !== "string" || !value) return 0;
	return value.split("\n").length - (value.endsWith("\n") ? 1 : 0);
}

function patchStats(diff: string) {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) added++;
		else if (line.startsWith("-") && !line.startsWith("---")) removed++;
	}
	return { added, removed };
}

function parsedJson(text: string | undefined): Record<string, unknown> | null {
	if (!text) return null;
	try {
		const value = JSON.parse(text);
		return value && typeof value === "object" ? value : null;
	} catch {
		return null;
	}
}

const sentence = (name: string) => {
	const words = name.replaceAll("_", " ").trim();
	return words.charAt(0).toUpperCase() + words.slice(1);
};

export function toolActivity(item: DynamicToolCallItem): ToolActivity {
	const input = parsedJson(item.input) ?? {};
	const output = parsedJson(item.output);
	const text = (key: string) =>
		typeof input[key] === "string" ? (input[key] as string) : undefined;
	const tool = item.tool;
	const mcp = mcpCallName(item);
	if (mcp)
		return {
			verb: mcp.serverLabel,
			target: mcp.toolLabel,
			glyph: "mcp",
			mcpServer: mcp.server,
		};
	// A lean surface's tool shows as its role (LEAN_SHAPE_TOOLS).
	const leanRole = leanToolRole(tool);
	switch (leanRole ? `lean:${leanRole}` : tool) {
		case "execute_command":
		case "start_command":
		case "shell":
		case "lean:command": {
			const command = text("command") ?? text("cmd");
			if (!command) return { verb: "Ran command" };
			const display = displayCommand(command);
			// One rule for the timeline: a recorded background command
			// (background-command.ts), or another harness's background start.
			const background =
				item.background !== undefined ||
				input.background === true ||
				input.run_in_background === true ||
				input.is_background === true ||
				output?.status === "running" ||
				/\bin background with ID\b/.test(item.output ?? "");
			return background
				? { verb: "Started", target: display, code: true, background: true }
				: {
						verb: "Ran",
						target: display,
						code: true,
						glyph: commandGlyph(display),
					};
		}
		case "continue_command":
		case "read_command":
		case "wait_command":
			return { verb: "Waited for command output", glyph: "wait" };
		case "stop_command":
			return { verb: "Stopped command", glyph: "stop" };
		case "lean:stdin":
			return text("chars")?.includes("\u0003")
				? { verb: "Stopped command", glyph: "stop" }
				: text("chars")
					? { verb: "Sent input to command", glyph: "wait" }
					: { verb: "Waited for command output", glyph: "wait" };
		case "lean:read":
		case "lean:image": {
			const path = text("file_path") ?? text("path");
			if (path && /\.(png|jpe?g|gif|webp)$/i.test(path))
				return {
					verb: "Viewed",
					target: basename(path),
					code: true,
					glyph: "image",
				};
			return {
				verb: "Read",
				target: path ? basename(path) : undefined,
				code: true,
				glyph: "read",
			};
		}
		case "lean:write":
			return {
				verb: "Wrote",
				target: basename(text("file_path") ?? text("path") ?? "file"),
				code: true,
				added: lineCount(text("content")),
			};
		case "lean:edit": {
			const edits = Array.isArray(input.edits)
				? (input.edits as Record<string, unknown>[])
				: [input];
			// Chats stored before 2026-10-17 used oldText/newText; read both for display.
			const strings = (key: string, legacy: string) =>
				edits.map((edit) => {
					const value = edit[key] ?? edit[legacy];
					return typeof value === "string" ? value : "";
				});
			return {
				verb: "Edited",
				target: basename(text("file_path") ?? text("path") ?? "file"),
				code: true,
				added: strings("new_string", "newText").reduce(
					(sum, value) => sum + lineCount(value),
					0,
				),
				removed: strings("old_string", "oldText").reduce(
					(sum, value) => sum + lineCount(value),
					0,
				),
			};
		}
		case "lean:glob":
			return {
				verb: "Found files",
				target: text("pattern"),
				code: true,
				glyph: "search",
			};
		case "lean:grep":
			return {
				verb: "Searched",
				target: text("pattern")
					? clip(text("pattern") as string, 80)
					: undefined,
				code: true,
				glyph: "search",
			};
		case "apply_patch": {
			const operation = (input.operation ?? {}) as Record<string, unknown>;
			// The freeform apply_patch input is the raw patch text, not JSON.
			const patch =
				typeof operation.diff === "string"
					? operation.diff
					: (text("patch") ??
						text("input") ??
						(item.input?.startsWith("*** Begin Patch") ? item.input : ""));
			const path =
				typeof operation.path === "string"
					? operation.path
					: (text("path") ??
						/\*\*\* (?:Update|Add|Delete) File: (.+)/.exec(patch)?.[1] ??
						/^\+\+\+ (?:b\/)?(?!\/dev\/null)(\S+)/m.exec(patch)?.[1]);
			const kind = String(operation.type ?? "");
			// A '*** Begin Patch' envelope: each file with its own verb.
			const files = [
				...patch.matchAll(/^\*\*\* (Update|Add|Delete) File: (.+)$/gm),
			].map(([, operation, file]) => ({
				verb:
					operation === "Add"
						? "Created"
						: operation === "Delete"
							? "Deleted"
							: "Edited",
				file: basename(file.trim()),
			}));
			if (!text("path") && typeof operation.path !== "string" && files.length)
				return {
					verb: files[0].verb,
					target: files[0].file,
					code: true,
					...patchStats(patch),
					...(files.length > 1
						? {
								note: files
									.slice(1)
									.map(({ verb, file }) => `${verb} ${file}`)
									.join(", "),
							}
						: {}),
				};
			const verb =
				/create|add/.test(kind) ||
				/\*\*\* Add File|^(?:---|\*\*\*) \/dev\/null/m.test(patch)
					? "Created"
					: /delete/.test(kind) || /\*\*\* Delete File/.test(patch)
						? "Deleted"
						: "Edited";
			return {
				verb,
				target: path ? basename(path) : undefined,
				code: true,
				...patchStats(patch),
			};
		}
		case "replace_text": {
			const path = text("path") ?? text("file_path");
			return {
				verb: "Edited",
				target: path ? basename(path) : undefined,
				code: true,
			};
		}
		case "read_repository_guidance": {
			const scope = text("scope");
			return {
				verb: "Read repository guidance",
				target: scope && scope !== "." ? scope : undefined,
				code: true,
				glyph: "guide",
			};
		}
		case "read_environment_report":
			return { verb: "Read environment report", glyph: "guide" };
		case "view_image":
			return {
				verb: "Viewed",
				target: text("path") ? basename(text("path") as string) : "image",
				code: true,
				glyph: "image",
			};
		case "web_search":
		case "google_search": {
			// Provider-hosted search: the query is in the input (Anthropic) or the result's action (OpenAI).
			const action =
				output && typeof output.action === "object" && output.action
					? (output.action as Record<string, unknown>)
					: undefined;
			const queries = Array.isArray(action?.queries)
				? (action.queries as unknown[]).filter(
						(query): query is string => typeof query === "string",
					)
				: [];
			const query =
				text("query") ??
				(typeof action?.query === "string" ? action.query : queries[0]);
			const url = typeof action?.url === "string" ? action.url : undefined;
			// Searches known only from their cited sources (OpenRouter).
			const cited = Array.isArray(output?.sources) ? output.sources.length : 0;
			return {
				verb: url ? "Opened" : "Searched the web",
				target: url ?? (query ? clip(query, 80) : undefined),
				note:
					queries.length > 1
						? `${queries.length} queries`
						: cited
							? `${cited} ${cited === 1 ? "source" : "sources"}`
							: undefined,
				glyph: "search",
			};
		}
		case CODE_MODE_TOOL: {
			// One card for the whole program; its inner calls are listed inside it,
			// summarized here by what they did ("Read ×2 · Edited · Ran").
			const calls = codeModeCallItems(item);
			const statuses = codeModeResult(item)?.calls ?? [];
			const counts = new Map<string, number>();
			for (const call of calls) {
				const verb = toolActivity(call).verb;
				counts.set(verb, (counts.get(verb) ?? 0) + 1);
			}
			const notCompleted = statuses.filter(
				(call) => call.status !== "completed",
			).length;
			return {
				verb: "Ran code",
				target: counts.size
					? clip(
							[...counts]
								.map(([verb, count]) =>
									count > 1 ? `${verb} ×${count}` : verb,
								)
								.join(" · "),
							80,
						)
					: undefined,
				note: calls.length
					? `${calls.length} ${calls.length === 1 ? "call" : "calls"}${notCompleted ? `, ${notCompleted} not completed` : ""}`
					: undefined,
			};
		}
		case "read_plugin_skill":
			return {
				verb: "Read skill",
				target: text("skill") ?? text("name"),
				code: true,
				glyph: "guide",
			};
	}
	const known = harnessToolActivity(tool, text, input, output);
	if (known) return known;
	const detail = text("path") ?? text("query") ?? text("title");
	return {
		verb: sentence(tool),
		target: detail ? clip(detail, 80) : undefined,
		code: Boolean(text("path")),
		fallback: true,
	};
}

const host = (url: string) =>
	url.replace(/^https?:\/\//, "").replace(/\/$/, "");
const plural = (count: number, word: string) =>
	`${count} ${word}${count === 1 ? "" : "s"}`;

/** The harness's own tools beyond the file and command ones, and the retired tools older chats hold. */
function harnessToolActivity(
	tool: string,
	text: (key: string) => string | undefined,
	input: Record<string, unknown>,
	output: Record<string, unknown> | null,
): ToolActivity | null {
	const outputValue = (output?.type === "json" ? output.value : output) as
		| Record<string, unknown>
		| null
		| undefined;
	const field = (key: string) =>
		typeof outputValue?.[key] === "string"
			? (outputValue[key] as string)
			: undefined;
	switch (tool) {
		case "check_deliverable": {
			const command = text("command");
			return {
				verb: "Checked deliverable",
				target: command ? displayCommand(command) : undefined,
				code: true,
			};
		}
		case "read_context_archive":
			return { verb: "Read earlier context" };
		case "search_context_history":
			return {
				verb: "Searched earlier context",
				target: text("query") ? clip(text("query") as string, 80) : undefined,
			};
		case "browser_open":
			return { verb: "Opened", target: host(text("url") ?? "page") };
		case "web_fetch":
			return {
				verb: "Fetched",
				target: text("url") ? clip(host(text("url") as string), 80) : "page",
			};
		case "browser_screenshot":
			return { verb: "Took a browser screenshot" };
		case "browser_inspect": {
			const checks = Array.isArray(input.assertions)
				? input.assertions.length
				: 0;
			return {
				verb: "Inspected",
				target: text("url") ? host(text("url") as string) : "page",
				note: checks ? plural(checks, "check") : undefined,
			};
		}
		case "browser_execute":
			return {
				verb: "Ran browser script",
				target: text("code") ? clip(text("code") as string, 60) : undefined,
				code: true,
			};
		case "browser_click":
			return { verb: "Clicked", target: text("selector") ?? text("text") };
		case "browser_type":
			return { verb: "Typed into page" };
		case "browser_key":
			return { verb: "Pressed", target: text("key"), code: true };
		case "report_task_blocked":
			return {
				verb: "Asked for a decision",
				target: text("question")
					? clip(text("question") as string, 80)
					: undefined,
			};
		case "enter_plan_mode":
			return {
				verb: "Entered plan mode",
				note: text("reason") ? clip(text("reason") as string, 80) : undefined,
			};
		case "propose_plan":
			return { verb: "Proposed a plan" };
		case "request_push_approval":
			return { verb: "Asked to push", target: text("branch") };
		case "ask_user":
			return { verb: "Asked you to choose" };
		case "request_project_secret": {
			const secrets = Array.isArray(input.secrets) ? input.secrets : null;
			if (!secrets)
				return { verb: "Asked for secret", target: text("name"), code: true };
			const first = (secrets[0] as { name?: unknown } | undefined)?.name;
			return secrets.length === 1 && typeof first === "string"
				? { verb: "Asked for secret", target: first, code: true }
				: { verb: "Asked for", target: plural(secrets.length, "secret") };
		}
		case "search_mcp_tools":
			return {
				verb: "Searched MCP tools",
				target: text("query") ? clip(text("query") as string, 80) : undefined,
			};
		case "call_mcp_tool":
			return { verb: "Called MCP tool" };
		case "agent": {
			const role = text("role") ?? (field("role") as string | undefined);
			const model = field("model");
			const outcome = field("outcome");
			return {
				verb:
					input.explore === true
						? "Started exploration"
						: role
							? `Started ${role}`
							: "Started agent",
				target: text("title"),
				note: [model, outcome].filter(Boolean).join(" · ") || undefined,
			};
		}
		case "agent_send": {
			const id =
				text("id") ??
				(typeof input.id === "number" ? String(input.id) : undefined);
			const status = field("status");
			return {
				verb:
					input.stop === true
						? "Stopped agent"
						: input.explore === true
							? "Sent exploration round to agent"
							: "Messaged agent",
				target: id,
				code: true,
				note: status ? clip(status, 60) : undefined,
			};
		}
		case "review_check":
			return { verb: "Independent review" };
		case "attempt_check":
			return { verb: "Attempts" };
		case "read_files": {
			const paths = Array.isArray(input.paths) ? input.paths.length : 0;
			return { verb: "Read", target: paths ? plural(paths, "file") : "files" };
		}
		case "list_files":
			return { verb: "Listed files", target: text("path"), code: true };
		case "search_files":
		case "search_tools":
			return {
				verb: "Searched",
				target: (text("query") ?? text("pattern"))?.slice(0, 80),
				code: true,
			};
		case "inspect_changes":
			return { verb: "Reviewed changes" };
		case "verify_changes":
		case "run_checks":
			return { verb: "Ran checks" };
		case "create_file":
			return {
				verb: "Created",
				target: basename(text("path") ?? "file"),
				code: true,
			};
		case "apply_patches":
			return { verb: "Edited files" };
		case "rename_symbol":
			return { verb: "Renamed symbol", target: text("newName"), code: true };
		case "rename_file":
			return {
				verb: "Renamed",
				target: text("from") ?? text("path"),
				code: true,
			};
		case "apply_code_action":
			return { verb: "Applied code action" };
		case "read_tool_output":
			return { verb: "Read earlier tool output" };
		case "compose_tools":
			return { verb: "Ran tool steps" };
		case "update_plan":
			return { verb: "Updated plan" };
		case "read_work_plan":
			return { verb: "Read plan" };
		case "plan_parallel_work":
			return { verb: "Planned parallel work" };
		case "remember_project":
			return { verb: "Saved to project memory" };
		case "inspect_project_evidence":
			return { verb: "Read project evidence" };
		case "inspect_code":
		case "inspect_code_batch":
		case "read_code":
			return {
				verb: "Inspected code",
				target: text("path") ? basename(text("path") as string) : undefined,
				code: true,
			};
		case "debug_program":
		case "debug_node":
			return { verb: "Debugged program" };
		case "prepare_code_tools":
			return { verb: "Prepared code tools" };
	}
	// The retired task tools of the removed lead/child design, in older chats.
	if (
		/^(read_task_|list_peers|send_peer_message|create_task|edit_task|start_task|list_tasks|send_task_message|request_task_wrap_up|inspect_task_diff|import_reviewed_task|mark_task_reviewed|publish_task)/.test(
			tool,
		)
	)
		return { verb: "Coordinated subagents", note: sentence(tool) };
	return null;
}
