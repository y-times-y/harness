import type { ModelMessage } from "ai";

type HistoryMatch = {
	messageIndex: number;
	excerpt: string;
	score: number;
	matchedQuery: string;
	context: {
		messageIndex: number;
		role: ModelMessage["role"];
		excerpt: string;
	}[];
};

function readableMessageText(message: ModelMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.map((part) => {
			if (part.type === "text" || part.type === "reasoning") return part.text;
			if (part.type === "tool-call")
				return `${part.toolName} ${JSON.stringify(part.input)}`;
			if (part.type === "tool-result")
				return `${part.toolName} ${JSON.stringify(part.output)}`;
			return "";
		})
		.join("\n");
}

function queryMatch(text: string, query: string) {
	const phrase = query.trim().toLocaleLowerCase();
	const terms = [...new Set(phrase.split(/\s+/))];
	const matched = terms.filter((term) => text.includes(term));
	if (matched.length < Math.ceil(terms.length / 2)) return null;
	return {
		score:
			Math.round((100 * matched.length) / terms.length) +
			(text.includes(phrase) ? 40 : 0),
		start: text.indexOf(matched[0]),
		matchedQuery: query,
	};
}

/** Ranked lexical evidence retrieval; provider metadata and opaque parts never enter search. */
export function searchContextMessages(
	messages: ModelMessage[],
	query: string,
	alternativeQueries: string[] = [],
): HistoryMatch[] {
	const queries = [...new Set([query, ...alternativeQueries])];
	if (
		alternativeQueries.length > 4 ||
		queries.some((value) => !value.trim() || value.length > 200)
	)
		throw new Error("Enter a search query of 1–200 characters.");
	const texts = messages.map(readableMessageText);
	return texts
		.flatMap((text, messageIndex) => {
			const best = queries
				.map((value) => queryMatch(text.toLocaleLowerCase(), value))
				.filter((match) => match !== null)
				.sort((a, b) => b.score - a.score)[0];
			if (!best) return [];
			const start = Math.max(0, best.start - 160);
			const context = [messageIndex - 1, messageIndex + 1]
				.filter(
					(index) => index >= 0 && index < messages.length && texts[index],
				)
				.map((index) => ({
					messageIndex: index,
					role: messages[index].role,
					excerpt: texts[index].slice(0, 300),
				}));
			return [
				{
					messageIndex,
					excerpt: text.slice(start, start + 1200),
					score: best.score,
					matchedQuery: best.matchedQuery,
					context,
				},
			];
		})
		.sort((a, b) => b.score - a.score || a.messageIndex - b.messageIndex);
}
