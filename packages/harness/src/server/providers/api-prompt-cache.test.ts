import { generateText } from "ai";
import { expect, it, vi } from "vitest";
import { connectedLanguageModel } from "./api-model";
import {
	apiPromptCacheSettings,
	openRouterCacheFetch,
} from "./api-prompt-cache";

const identity = {
	userId: "alice",
	connectionId: "connection",
	scopeId: "chat",
};

it("uses opaque, stable, owner/connection/chat-separated routing keys", () => {
	const input = {
		...identity,
		provider: "openrouter" as const,
		baseUrl: "https://openrouter.ai/api/v1",
	};
	const original = apiPromptCacheSettings(input);
	expect(original).toEqual(apiPromptCacheSettings(input));
	for (const field of ["userId", "connectionId", "scopeId"] as const)
		expect(apiPromptCacheSettings({ ...input, [field]: "other" })).not.toEqual(
			original,
		);
	expect(JSON.stringify(original)).not.toContain("alice");
});

it("does not send undocumented settings to arbitrary compatible endpoints", () => {
	for (const provider of [
		"openai",
		"anthropic",
		"google",
		"openrouter",
		"compatible",
	] as const)
		expect(
			apiPromptCacheSettings({
				...identity,
				provider,
				baseUrl: "https://example.com/v1",
			}),
		).toEqual({});
});

it.each([
	[
		"anthropic",
		"https://api.anthropic.com/v1",
		"claude-sonnet-5-5",
		"cache_control",
	],
	["openai", "https://api.openai.com/v1", "gpt-6", "prompt_cache_key"],
	[
		"compatible",
		"https://api.mistral.ai/v1",
		"mistral-large-latest",
		"prompt_cache_key",
	],
	[
		"compatible",
		"https://api.meta.ai/v1",
		"muse-spark-1.3",
		"prompt_cache_key",
	],
] as const)(
	"serializes %s cache settings through the real SDK",
	async (provider, baseUrl, modelId, field) => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => {
			throw new Error("fixture-stop");
		});
		const model = connectedLanguageModel(
			{ provider, baseUrl, modelId, apiKey: "fixture-secret" },
			fetch,
		);
		await expect(
			generateText({
				model,
				prompt: "Unchanged prompt",
				maxRetries: 0,
				...apiPromptCacheSettings({ ...identity, provider, baseUrl }),
			}),
		).rejects.toThrow("fixture-stop");
		const body = JSON.parse(fetch.mock.calls[0][1]?.body as string);
		expect(body[field]).toEqual(
			field === "cache_control"
				? { type: "ephemeral" }
				: expect.stringMatching(/^[a-f0-9]{64}$/),
		);
	},
);

it("adds xAI affinity without changing generation settings", () => {
	expect(
		apiPromptCacheSettings({
			...identity,
			provider: "compatible",
			baseUrl: "https://api.x.ai/v1",
		}),
	).toEqual({
		headers: { "x-grok-conv-id": expect.stringMatching(/^[a-f0-9]{64}$/) },
	});
});

it.each(["anthropic/claude-sonnet-5-5", "qwen/qwen3-coder-plus"])(
	"marks the final tool result for %s without changing other content or tools",
	async (model) => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () => new Response("{}"),
		);
		const body = {
			model,
			stream: true,
			messages: [
				{ role: "system", content: "Stable system" },
				{
					role: "user",
					content: [
						{
							type: "image_url",
							image_url: { url: "https://example.com/image.png" },
						},
						{ type: "text", text: "Inspect this" },
					],
				},
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "call",
							type: "function",
							function: { name: "read_file", arguments: "{}" },
						},
					],
				},
				{ role: "tool", tool_call_id: "call", content: "File content" },
			],
			tools: [{ type: "function", function: { name: "read_file" } }],
		};
		await openRouterCacheFetch(fetch)(
			"https://openrouter.ai/api/v1/chat/completions",
			{ body: JSON.stringify(body) },
		);
		const sent = JSON.parse(fetch.mock.calls[0][1]?.body as string);
		const ephemeral = { type: "ephemeral" };
		// The breakpoint follows the final tool result so the tool loop is cached.
		expect(sent.messages[3].content).toEqual([
			{ type: "text", text: "File content", cache_control: ephemeral },
		]);
		expect(sent.messages[0].content).toEqual(
			model.startsWith("anthropic/")
				? [{ type: "text", text: "Stable system", cache_control: ephemeral }]
				: "Stable system",
		);
		expect(sent.messages[1]).toEqual(body.messages[1]);
		expect(sent.messages[2]).toEqual(body.messages[2]);
		expect(sent.tools).toEqual(body.tools);
	},
);

it("preserves existing breakpoints, unsupported models, empty text and non-JSON requests", async () => {
	const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("{}"));
	const cachedFetch = openRouterCacheFetch(fetch);
	for (const body of [
		{
			model: "anthropic/claude-sonnet-5-5",
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: "Test",
							cache_control: { type: "ephemeral", ttl: "1h" },
						},
					],
				},
			],
		},
		{
			model: "anthropic/claude-sonnet-5-5",
			cache_control: { type: "ephemeral" },
			messages: [{ role: "user", content: "Test" }],
		},
		{
			model: "meta/muse-spark-1.3",
			messages: [{ role: "user", content: "Test" }],
		},
		{ model: "qwen/unknown", messages: [{ role: "user", content: "Test" }] },
		// A moving Gemini breakpoint rewrites its explicit cache every step;
		// implicit prefix caching covers the growing tool loop instead.
		{
			model: "google/gemini-3.8-flash",
			messages: [
				{ role: "system", content: "Stable system" },
				{ role: "user", content: "Test" },
				{ role: "tool", tool_call_id: "call", content: "File content" },
			],
		},
		{
			model: "anthropic/claude-sonnet-5-5",
			messages: [{ role: "user", content: "" }],
		},
	]) {
		const init = { body: JSON.stringify(body) };
		await cachedFetch("https://openrouter.ai/api/v1/chat/completions", init);
		expect(fetch.mock.calls.at(-1)?.[1]).toBe(init);
	}
	await cachedFetch("https://openrouter.ai/api/v1/models");
	expect(fetch.mock.calls.at(-1)?.[1]).toBeUndefined();
});
