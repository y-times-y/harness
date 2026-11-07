import { generateText, tool } from "ai";
import { expect, it } from "vitest";
import { z } from "zod";
import { connectedLanguageModel } from "./api-model";
import { nativeWebSearchTools } from "./native-web-search";

it("offers each provider's own hosted search and nothing for others", () => {
	expect(Object.keys(nativeWebSearchTools("openai"))).toEqual(["web_search"]);
	expect(Object.keys(nativeWebSearchTools("anthropic"))).toEqual([
		"web_search",
	]);
	expect(Object.keys(nativeWebSearchTools("google"))).toEqual([
		"google_search",
	]);
	expect(Object.keys(nativeWebSearchTools("openrouter"))).toEqual([
		"web_search",
	]);
	expect(nativeWebSearchTools("compatible")).toEqual({});
	// Hosted tools run on the provider: no local execute for hooks or plan mode to wrap.
	for (const provider of ["openai", "openrouter"] as const)
		for (const hosted of Object.values(nativeWebSearchTools(provider)))
			expect((hosted as { execute?: unknown }).execute).toBeUndefined();
});

it("sends OpenRouter's web search server tool beside function tools", async () => {
	let body: { tools?: { type: string }[] } = {};
	const model = connectedLanguageModel(
		{
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			apiKey: "key",
			modelId: "openai/gpt-6-luna",
		},
		async (_url, init) => {
			body = JSON.parse(String(init?.body));
			throw new Error("fixture-stop");
		},
	);
	await expect(
		generateText({
			model,
			prompt: "latest wrangler version?",
			maxRetries: 0,
			tools: {
				...nativeWebSearchTools("openrouter"),
				read_file: tool({
					inputSchema: z.object({ path: z.string() }),
					execute: async () => "",
				}),
			},
		}),
	).rejects.toThrow("fixture-stop");
	expect(body.tools?.map((entry) => entry.type)).toEqual(
		expect.arrayContaining(["openrouter:web_search", "function"]),
	);
});
