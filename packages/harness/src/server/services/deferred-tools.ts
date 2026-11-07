import type { ModelMessage, ToolSet } from "ai";
import {
	CALL_MCP_TOOL_TOOL,
	SEARCH_MCP_TOOLS_TOOL,
} from "../../domain/mcp-tool-call";
import type { SessionItem } from "../../domain/session-item";

/**
 * Deferred tools (docs/parallel-evals.md, codeMode): tools that exist for
 * the turn but are not in the request's tool list. Only two kinds remain;
 * every other workflow tool (agent, agent_send, ask_user,
 * request_project_secret) is an ordinary always-visible tool.
 *
 * - Code mode primary: a large MCP setup's search_mcp_tools/call_mcp_tool
 *   are called only from run_code (searchTools(query) there returns their
 *   declarations). The per-server tool-name listing stays in the prompt.
 * - Force-loaded tools: offered regardless of earlier discovery.
 *
 * The tool list stays byte-stable for the provider prompt cache: the
 * always-on tools keep their order and never change within a chat; a tool
 * added later (forced while planning, or called directly before) is
 * appended after everything added before it and stays for the rest of the
 * chat. The added order is rebuilt from the chat's own recorded calls, so a
 * reloaded turn sends the same list.
 */

/** Tools added to the list in order, from the chat's recorded calls. */
export function loadedDeferredToolsFromItems(
	items: readonly SessionItem[],
	deferred: ReadonlySet<string>,
): string[] {
	const loaded: string[] = [];
	for (const item of items)
		if (
			item.kind === "dynamicToolCall" &&
			deferred.has(item.tool) &&
			!loaded.includes(item.tool)
		)
			loaded.push(item.tool);
	return loaded;
}

/** The same, from model messages (the current turn's calls before they reach the items). */
export function loadedDeferredToolsFromMessages(
	messages: readonly ModelMessage[],
	deferred: ReadonlySet<string>,
): string[] {
	const loaded: string[] = [];
	for (const message of messages) {
		if (typeof message.content === "string") continue;
		for (const part of message.content)
			if (
				part.type === "tool-call" &&
				deferred.has(part.toolName) &&
				!loaded.includes(part.toolName)
			)
				loaded.push(part.toolName);
	}
	return loaded;
}

export type DeferredToolSurface = {
	/** Every tool, deferred ones included: what the loop and run_code may execute. */
	readonly tools: ToolSet;
	/** The tools the next request offers, in order: always-on, then added tools in order. */
	readonly order: () => readonly string[];
	/**
	 * Every listed deferred tool's name and one-line description, sorted by
	 * name: the system prompt lists them so the model knows they exist. It
	 * depends only on the turn's tools, never on what was added, so it stays
	 * byte-stable across steps and turns.
	 */
	readonly deferred: readonly DeferredToolEntry[];
};

export type DeferredToolEntry = {
	readonly name: string;
	readonly description: string;
};

/** A tool description's first sentence, for the system prompt's list. */
export function oneLineDescription(description: string | undefined) {
	const text = (description ?? "").replace(/\s+/g, " ").trim();
	const sentence = /^.*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text;
	return sentence.length > 160 ? `${sentence.slice(0, 157)}...` : sentence;
}

/**
 * The system prompt's list of the tools only run_code can call (code mode
 * primary). Empty when nothing is deferred, so searchTools goes unmentioned.
 */
export function deferredToolsInstructions(
	entries: readonly DeferredToolEntry[],
) {
	if (!entries.length) return "";
	return [
		"More tools are not in your tool list; call them from inside run_code as tools.<name>(args). In a program, searchTools(query) returns their TypeScript declarations (arguments and what they do):",
		...entries.map((entry) => `- ${entry.name}: ${entry.description}`),
	].join("\n");
}

/**
 * Splits a turn's final tool set into the always-on list and deferred
 * tools. With nothing deferred the set is returned unchanged.
 */
export function deferredToolSurface(input: {
	readonly tools: ToolSet;
	readonly deferred: readonly string[];
	/** Added earlier in this chat, in order. */
	readonly loaded: readonly string[];
	/**
	 * Offered regardless, appended like an earlier addition: a list at
	 * setup, or a function read on every request.
	 */
	readonly forceLoaded?: readonly string[] | (() => readonly string[]);
	/** Deferred tools left out of the prompt's list (offered only when forced). */
	readonly unlisted?: readonly string[];
}): DeferredToolSurface {
	const deferred = new Set(
		input.deferred.filter((name) => name in input.tools),
	);
	const allNames = Object.keys(input.tools);
	if (!deferred.size)
		return { tools: input.tools, order: () => allNames, deferred: [] };
	const unlisted = new Set(input.unlisted ?? []);
	const entries = [...deferred]
		.filter((name) => !unlisted.has(name))
		.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
		.map((name) => ({
			name,
			description: oneLineDescription(
				typeof input.tools[name]?.description === "string"
					? input.tools[name]?.description
					: undefined,
			),
		}));
	const alwaysOn = allNames.filter((name) => !deferred.has(name));
	const loaded: string[] = [];
	const load = (name: string) => {
		if (deferred.has(name) && !loaded.includes(name)) loaded.push(name);
	};
	const forced = input.forceLoaded;
	for (const name of [
		...input.loaded,
		...(typeof forced === "function" ? [] : (forced ?? [])),
	])
		load(name);
	return {
		tools: input.tools,
		order: () => {
			if (typeof forced === "function") for (const name of forced()) load(name);
			return [...alwaysOn, ...loaded];
		},
		deferred: entries,
	};
}

/**
 * Code mode primary: a large MCP setup's search and call tools (they exist
 * only then, mcp-tool-surface.ts) are callable only from run_code.
 */
export const CODE_MODE_DEFERRED_TOOLS: readonly string[] = [
	SEARCH_MCP_TOOLS_TOOL,
	CALL_MCP_TOOL_TOOL,
];

/**
 * The deferred tools a chat has added, in order: its recorded calls (every
 * earlier turn, compaction included), then this turn's model messages not
 * yet in the items.
 */
export function loadedDeferredTools(
	items: readonly SessionItem[],
	messages: readonly ModelMessage[],
	deferredNames: readonly string[],
) {
	const deferred = new Set(deferredNames);
	const loaded = loadedDeferredToolsFromItems(items, deferred);
	for (const name of loadedDeferredToolsFromMessages(messages, deferred))
		if (!loaded.includes(name)) loaded.push(name);
	return loaded;
}
