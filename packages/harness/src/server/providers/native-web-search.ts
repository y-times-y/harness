import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";
import { openrouter } from "@openrouter/ai-sdk-provider";
import type { ToolSet } from "ai";
import type { ModelProvider } from "../../domain/model-connection";

/**
 * The model provider's own hosted web search, so agents can look up docs, errors
 * and releases. It runs and is billed on the provider, with no ytimesy search
 * backend. A ChatGPT plan route uses OpenAI's. On OpenRouter the model calls its
 * web search server tool, which uses the maker's native search or Exa and bills
 * the user's OpenRouter credits. Compatible endpoints get none; their users can
 * add a search MCP server instead.
 */
export function nativeWebSearchTools(provider: ModelProvider): ToolSet {
	switch (provider) {
		case "openai":
			// Batches up to several queries per call and can open and search pages.
			return {
				web_search: openai.tools.webSearch({ searchContextSize: "medium" }),
			};
		case "anthropic":
			return {
				web_search: anthropic.tools.webSearch_20260318({ maxUses: 10 }),
			};
		case "google":
			return { google_search: google.tools.googleSearch({}) };
		case "openrouter":
			// A server tool the model calls when needed, not the per-request web plugin.
			return { web_search: openrouter.tools.webSearch({ maxResults: 5 }) };
		default:
			return {};
	}
}
