import { expect, it, vi } from "vitest";
import { readModelContext } from "./model-context";

const browse = vi.hoisted(() => vi.fn());
vi.mock("./browse-models", () => ({ browseModels: browse }));

it("only enables Claude native compaction from owner-authenticated advertised capability", async () => {
	const fetch = vi.fn(async () =>
		Response.json({
			max_input_tokens: 200_000,
			capabilities: { compaction: { supported: true } },
		}),
	);
	const input = {
		provider: "anthropic" as const,
		baseUrl: "https://api.anthropic.com/v1",
		apiKey: "fixture-key",
		modelId: "claude-fixture",
		cacheKey: "owner-a/native",
	};
	expect(await readModelContext(input, fetch)).toEqual({
		contextWindow: 200_000,
		nativeCompaction: "anthropic",
	});
	expect(fetch.mock.calls[0]).toBeDefined();
	await readModelContext(input, fetch);
	expect(fetch).toHaveBeenCalledTimes(1);
	await readModelContext({ ...input, cacheKey: "owner-b/native" }, fetch);
	expect(fetch).toHaveBeenCalledTimes(2);
});

it("uses provider context metadata without treating context editing as signed on-demand compaction", async () => {
	const fetch = vi.fn(async () =>
		Response.json({
			max_input_tokens: 100_000,
			capabilities: { context_management: { supported: true } },
		}),
	);
	expect(
		await readModelContext(
			{
				provider: "anthropic",
				baseUrl: "https://api.anthropic.com/v1",
				apiKey: "fixture",
				modelId: "old-model",
				cacheKey: "context-only",
			},
			fetch,
		),
	).toEqual({ contextWindow: 100_000, nativeCompaction: undefined });
});

it("does not send credentials to metadata paths on custom compatible endpoints", async () => {
	const fetch = vi.fn();
	expect(
		await readModelContext(
			{
				provider: "compatible",
				baseUrl: "https://custom.example/v1",
				apiKey: "fixture",
				modelId: "gpt-6-fixture",
				cacheKey: "custom",
				contextWindow: 16_000,
			},
			fetch,
		),
	).toEqual({ contextWindow: 16_000, nativeCompaction: undefined });
	expect(fetch).not.toHaveBeenCalled();
});

it.each([
	["openai", "https://api.openai.com/v1", "gpt-5.4", "openai-endpoint"],
	["compatible", "https://api.x.ai/v1", "grok-4.7", "xai"],
	["compatible", "https://api.x.ai/v1", "grok-4.6", undefined],
	["compatible", "https://custom.example/v1", "grok-4.7", undefined],
] as const)(
	"selects only documented official compact routes: %s %s %s",
	async (provider, baseUrl, modelId, nativeCompaction) => {
		const context = await readModelContext(
			{
				provider,
				baseUrl,
				modelId,
				apiKey: "fixture",
				contextWindow: 100_000,
				cacheKey: `${baseUrl}/${modelId}/compact-proof`,
			},
			vi.fn(),
		);
		expect(context.nativeCompaction).toBe(nativeCompaction);
	},
);

it("reads an OpenRouter model missing from the public list from its endpoints, without credentials", async () => {
	browse.mockResolvedValue([
		{ id: "listed/model", label: "Listed", author: "listed", created: 0 },
	]);
	const fetch = vi.fn(
		async (_url: string | URL | Request, _init?: RequestInit) =>
			Response.json({
				data: {
					id: "vendor/unlisted:free",
					endpoints: [{ context_length: 131_072 }, { context_length: 262_144 }],
				},
			}),
	);
	const context = await readModelContext(
		{
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			apiKey: "fixture-secret",
			modelId: "vendor/unlisted:free",
			cacheKey: "openrouter-unlisted",
		},
		fetch,
	);
	expect(context.contextWindow).toBe(262_144);
	expect(String(fetch.mock.calls[0][0])).toBe(
		"https://openrouter.ai/api/v1/models/vendor/unlisted:free/endpoints",
	);
	expect(JSON.stringify(fetch.mock.calls[0][1])).not.toContain(
		"fixture-secret",
	);
});

it("prefers the public OpenRouter catalog and leaves a truly unknown window undefined", async () => {
	browse.mockResolvedValue([
		{
			id: "vendor/listed",
			label: "Listed",
			author: "vendor",
			created: 0,
			contextWindow: 200_000,
		},
	]);
	const fetch = vi.fn(async () => new Response("{}", { status: 404 }));
	const base = {
		provider: "openrouter" as const,
		baseUrl: "https://openrouter.ai/api/v1",
		apiKey: "fixture",
	};
	expect(
		(
			await readModelContext(
				{ ...base, modelId: "vendor/listed", cacheKey: "listed" },
				fetch,
			)
		).contextWindow,
	).toBe(200_000);
	expect(fetch).not.toHaveBeenCalled();
	expect(
		(
			await readModelContext(
				{ ...base, modelId: "vendor/gone", cacheKey: "gone" },
				fetch,
			)
		).contextWindow,
	).toBeUndefined();
});

it("reads an unrecorded custom endpoint window from the same model listing discovery uses", async () => {
	const fetch = vi.fn(
		async (_url: string | URL | Request, _init?: RequestInit) =>
			Response.json({
				data: [
					{ id: "other", context_length: 8_000 },
					{ id: "local-coder", max_model_len: 65_536 },
				],
			}),
	);
	const context = await readModelContext(
		{
			provider: "compatible",
			baseUrl: "https://custom.example/v1",
			apiKey: "fixture",
			modelId: "local-coder",
			cacheKey: "custom-unrecorded",
		},
		fetch,
	);
	expect(context.contextWindow).toBe(65_536);
	expect(String(fetch.mock.calls[0][0])).toBe(
		"https://custom.example/v1/models",
	);
});

it("reads image input from the public catalog for a model without a checked-in entry", async () => {
	browse.mockResolvedValue([
		{ id: "vendor/text-only", imageInput: false, contextWindow: 64_000 },
	]);
	const context = await readModelContext(
		{
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			apiKey: "fixture",
			modelId: "vendor/text-only",
			cacheKey: "image-input",
		},
		vi.fn(),
	);
	expect(context.imageInput).toBe(false);
	browse.mockReset();
});

it("uses a routed model's checked-in window and image input without any catalog request", async () => {
	browse.mockRejectedValue(new Error("catalog down"));
	const fetch = vi.fn();
	for (const [provider, baseUrl, modelId] of [
		[
			"openai",
			"https://bedrock-mantle.us-east-1.api.aws/openai/v1",
			"gpt-6-astra",
		],
		["openai", "https://api.openai.com/v1", "gpt-6.1-sol"],
		["openrouter", "https://openrouter.ai/api/v1", "openai/gpt-6-luna"],
	] as const) {
		const context = await readModelContext(
			{
				provider,
				baseUrl,
				apiKey: "fixture",
				modelId,
				cacheKey: `known/${modelId}`,
			},
			fetch,
		);
		expect(context).toMatchObject({
			contextWindow: 1_050_000,
			imageInput: true,
		});
	}
	expect(browse).not.toHaveBeenCalled();
	expect(fetch).not.toHaveBeenCalled();
	browse.mockReset();
});

it("falls back to the checked-in window when owner metadata is unreachable", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	const fetch = vi.fn(async () => {
		throw new TypeError("fetch failed");
	});
	const context = await readModelContext(
		{
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com/v1",
			apiKey: "fixture",
			modelId: "claude-opus-5-5",
			cacheKey: "anthropic-down",
		},
		fetch,
	);
	expect(context.contextWindow).toBe(1_000_000);
	expect(warn).toHaveBeenCalledWith(
		"Model context metadata unavailable.",
		expect.objectContaining({ modelId: "claude-opus-5-5", error: "TypeError" }),
	);
	warn.mockRestore();
});

it("warns once per lookup, naming the model, when a window stays unknown", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	browse.mockRejectedValue(new Error("catalog down"));
	const context = await readModelContext(
		{
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			apiKey: "fixture",
			modelId: "gpt-unlisted",
			cacheKey: "unknown-window",
		},
		vi.fn(),
	);
	expect(context.contextWindow).toBeUndefined();
	expect(warn).toHaveBeenCalledWith(
		"Model context window unknown; the run uses the unknown-window budget.",
		{ provider: "openai", modelId: "gpt-unlisted", assumedWindow: 128_000 },
	);
	warn.mockRestore();
	browse.mockReset();
});
