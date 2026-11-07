import { createHash } from "node:crypto";
import type { generateText } from "ai";
import type { ModelProvider } from "../../domain/model-connection";

export function promptCacheScopeKey(input: {
	userId: string;
	connectionId: string;
	scopeId: string;
}) {
	return createHash("sha256")
		.update(JSON.stringify([input.userId, input.connectionId, input.scopeId]))
		.digest("hex");
}

export function apiPromptCacheSettings(input: {
	provider: ModelProvider;
	baseUrl: string;
	userId: string;
	connectionId: string;
	scopeId: string;
}): Pick<Parameters<typeof generateText>[0], "providerOptions" | "headers"> {
	const key = promptCacheScopeKey(input);
	const host = new URL(input.baseUrl).hostname;
	if (input.provider === "anthropic" && host === "api.anthropic.com")
		return {
			providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
		};
	if (input.provider === "openai" && host === "api.openai.com")
		return { providerOptions: { openai: { promptCacheKey: key } } };
	if (input.provider === "openrouter" && host === "openrouter.ai")
		return { headers: { "x-session-id": key } };
	if (input.provider === "compatible") {
		if (host === "api.x.ai") return { headers: { "x-grok-conv-id": key } };
		if (host === "api.meta.ai")
			return { providerOptions: { openai: { promptCacheKey: key } } };
		if (host === "api.mistral.ai")
			return { providerOptions: { compatible: { prompt_cache_key: key } } };
	}
	return {};
}

const ALIBABA_CACHE_MODELS = new Set([
	"qwen/qwen3-max",
	"qwen/qwen-plus",
	"qwen/qwen3.6-plus",
	"qwen/qwen3-coder-plus",
	"qwen/qwen3-coder-flash",
]);

/**
 * The generic SDK drops content-block provider metadata; amend only documented
 * gateway routes. Gemini is deliberately not marked: OpenRouter uses only the
 * last Gemini breakpoint and writes a fixed-TTL cache for exactly that prefix,
 * so a breakpoint that follows each step's final message pays a fresh cache
 * write every step and never reads it back. Unmarked requests use Gemini's
 * implicit prefix caching (no write charge), kept on one endpoint by the
 * session id sticky routing.
 */
export function openRouterCacheFetch(
	fetch: typeof globalThis.fetch,
): typeof globalThis.fetch {
	return async (url, init) => {
		if (typeof init?.body !== "string") return fetch(url, init);
		const body = JSON.parse(init.body);
		const model =
			typeof body.model === "string" ? body.model.replace(/:.*$/, "") : "";
		if (!(model.startsWith("anthropic/") || ALIBABA_CACHE_MODELS.has(model)))
			return fetch(url, init);
		if (!Array.isArray(body.messages)) return fetch(url, init);
		// Do not add another breakpoint when the caller has already configured caching.
		if (
			body.cache_control ||
			body.messages.some(
				(value: { content?: unknown }) =>
					Array.isArray(value.content) &&
					value.content.some((part) => part.cache_control),
			)
		)
			return fetch(url, init);
		// Block markers preserve gateway endpoint choice; top-level Claude caching can restrict routing.
		// Tool loops end in tool results or tool-call-only assistant turns, so the
		// breakpoint must follow the final message of any role, not the last user text.
		const marked = [
			body.messages.findLastIndex((value: unknown) => markable(value)),
		];
		if (model.startsWith("anthropic/")) {
			const system = body.messages.findIndex(
				(value: { role?: string }) => value.role === "system",
			);
			if (
				system >= 0 &&
				markable(body.messages[system]) &&
				system !== marked[0]
			)
				marked.push(system);
		}
		if (marked[0] < 0) return fetch(url, init);
		for (const index of marked)
			body.messages[index] = withBreakpoint(body.messages[index]);
		return fetch(url, { ...init, body: JSON.stringify(body) });
	};
}

type TextPart = { type?: string; text?: unknown };

function textParts(content: unknown): TextPart[] | null {
	if (typeof content === "string")
		return content.length ? [{ type: "text", text: content }] : null;
	return Array.isArray(content) ? (content as TextPart[]) : null;
}

function lastTextIndex(parts: TextPart[]) {
	for (let index = parts.length - 1; index >= 0; index--) {
		const part = parts[index];
		if (part.type === "text" && typeof part.text === "string" && part.text)
			return index;
	}
	return -1;
}

function markable(value: unknown) {
	const message = value as { role?: string; content?: unknown };
	if (!["system", "user", "assistant", "tool"].includes(message.role ?? ""))
		return false;
	const parts = textParts(message.content);
	return parts !== null && lastTextIndex(parts) >= 0;
}

function withBreakpoint(value: { content?: unknown }) {
	const parts = textParts(value.content) ?? [];
	const index = lastTextIndex(parts);
	return {
		...value,
		content: parts.map((part, position) =>
			position === index
				? { ...part, cache_control: { type: "ephemeral" } }
				: part,
		),
	};
}
