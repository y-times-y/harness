import type { ModelMessage } from "ai";

const MAX_SOURCES = 8;
const MAX_NOTE_CHARS = 1200;

/**
 * The model history with each provider-executed web search written as a
 * short assistant note ("Web search: <query> — sources: <url>, ...").
 *
 * With store:false the OpenAI Responses adapter drops provider-executed tool
 * calls and their results from replayed history (it can only reference them
 * by item id, which needs a stored response), so from the next step on the
 * model no longer knew what it searched or which pages it found. The note
 * keeps that record in plain text in the search's place; reasoning parts and
 * every other part are left exactly as they are. Deterministic, so the same
 * history serializes the same bytes on every request.
 */
export function withWebSearchNotes(
	messages: readonly ModelMessage[],
): ModelMessage[] {
	return messages.map((message) => {
		if (message.role !== "assistant" || typeof message.content === "string")
			return message;
		if (!message.content.some(isHostedSearchPart)) return message;
		const content: typeof message.content = [];
		for (const part of message.content) {
			if (!isHostedSearchPart(part)) content.push(part);
			else if (part.type === "tool-result")
				content.push({ type: "text", text: webSearchNote(part.output) });
		}
		return { ...message, content };
	});
}

type AssistantPart = Exclude<
	Extract<ModelMessage, { role: "assistant" }>["content"],
	string
>[number];

function isHostedSearchPart(part: AssistantPart) {
	return (
		(part.type === "tool-call" || part.type === "tool-result") &&
		part.toolName === "web_search" &&
		(part.type === "tool-result" || part.providerExecuted === true)
	);
}

/** One line for a web_search result (the adapter's mapped action and sources). */
export function webSearchNote(output: unknown) {
	const value = (
		output &&
		typeof output === "object" &&
		"type" in output &&
		"value" in output
			? (output as { value: unknown }).value
			: output
	) as {
		action?: {
			type?: string;
			query?: unknown;
			queries?: unknown;
			url?: unknown;
			pattern?: unknown;
		};
		sources?: unknown;
	} | null;
	const action = value?.action;
	let note: string;
	if (action?.type === "openPage" && typeof action.url === "string")
		note = `Web search opened ${action.url}`;
	else if (action?.type === "findInPage" && typeof action.url === "string")
		note = `Web search looked for "${String(action.pattern ?? "")}" in ${action.url}`;
	else {
		const queries = [
			...(typeof action?.query === "string" ? [action.query] : []),
			...(Array.isArray(action?.queries)
				? action.queries.filter(
						(query): query is string =>
							typeof query === "string" && query !== action?.query,
					)
				: []),
		];
		const urls = [
			...new Set(
				(Array.isArray(value?.sources) ? value.sources : [])
					.map((source: { url?: unknown }) => source?.url)
					.filter((url): url is string => typeof url === "string"),
			),
		];
		note = `Web search: ${queries.length ? queries.join("; ") : "(query not recorded)"}`;
		if (urls.length)
			note += ` — sources: ${urls.slice(0, MAX_SOURCES).join(", ")}${
				urls.length > MAX_SOURCES ? `, +${urls.length - MAX_SOURCES} more` : ""
			}`;
	}
	return note.length > MAX_NOTE_CHARS
		? `${note.slice(0, MAX_NOTE_CHARS - 1)}…`
		: note;
}
