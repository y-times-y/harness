import { describe, expect, it } from "vitest";
import {
	apiContextWindowOption,
	availableConnectionModels,
	connectionModelSpeeds,
	modelConnectionInput,
	modelRouteId,
	officialProviderEndpoint,
	parseModelRouteId,
	publicModelEndpoint,
} from "./model-connection";

describe("model connections", () => {
	it.each([
		"http://example.com/v1",
		"https://user:secret@example.com",
		"https://example.com?key=secret",
		"https://example.com#secret",
		"https://example.com:8443",
	])("rejects unsafe endpoint syntax %s", (value) => {
		expect(() => publicModelEndpoint(value)).toThrow();
	});
	it("normalizes URLs and prevents overriding native endpoints", () => {
		expect(publicModelEndpoint("https://example.com/v1/")).toBe(
			"https://example.com/v1",
		);
		expect(
			modelConnectionInput.parse({
				provider: "openai",
				label: "Work",
				apiKey: "fixture-key",
				baseUrl: "https://elsewhere.example",
			}).baseUrl,
		).toBe("https://api.openai.com/v1");
	});
	it("round trips provider model IDs without mixing connections", () => {
		const connectionId = "12345678-1234-4123-8123-123456789012";
		expect(
			parseModelRouteId(modelRouteId(connectionId, "vendor/model:version")),
		).toEqual({ connectionId, modelId: "vendor/model:version" });
		expect(parseModelRouteId("api/wrong/model")).toBeNull();
		expect(parseModelRouteId(`api/${connectionId}/%xx`)).toBeNull();
	});
});

describe("officialProviderEndpoint", () => {
	it("accepts only the provider's own API origin", () => {
		expect(
			officialProviderEndpoint({
				provider: "openai",
				baseUrl: "https://api.openai.com/v1",
			}),
		).toBe(true);
		expect(
			officialProviderEndpoint({
				provider: "anthropic",
				baseUrl: "https://api.anthropic.com/v1",
			}),
		).toBe(true);
		expect(
			officialProviderEndpoint({
				provider: "openai",
				baseUrl: "https://proxy.example.com/v1",
			}),
		).toBe(false);
		expect(
			officialProviderEndpoint({
				provider: "compatible",
				baseUrl: "https://api.openai.com/v1",
			}),
		).toBe(false);
		expect(
			officialProviderEndpoint({
				provider: "openrouter",
				baseUrl: "https://openrouter.ai/api/v1",
			}),
		).toBe(true);
	});
});

describe("apiContextWindowOption", () => {
	const openai = {
		provider: "openai" as const,
		baseUrl: "https://api.openai.com/v1",
	};
	const openrouter = {
		provider: "openrouter" as const,
		baseUrl: "https://openrouter.ai/api/v1",
	};
	const xai = {
		provider: "compatible" as const,
		baseUrl: "https://api.x.ai/v1",
	};
	it("keeps the full window by default and offers the cheaper price tier", () => {
		expect(apiContextWindowOption(openai, "gpt-6.1-sol")).toEqual({
			standard: 1_050_000,
			alternate: 272_000,
			note: "Stays under the 272K price tier (2× input, 1.5× output past it)",
		});
		expect(
			apiContextWindowOption(openrouter, "openai/gpt-6-astra"),
		).toMatchObject({ standard: 1_050_000, alternate: 272_000 });
		expect(apiContextWindowOption(xai, "grok-4.7")).toMatchObject({
			standard: 500_000,
			alternate: 200_000,
		});
		expect(apiContextWindowOption(openrouter, "x-ai/grok-4.6")).toMatchObject({
			standard: 500_000,
			alternate: 200_000,
		});
		expect(
			apiContextWindowOption(
				{ provider: "anthropic", baseUrl: "https://api.anthropic.com/v1" },
				"claude-haiku-5-5",
			),
		).toMatchObject({ standard: 1_000_000, alternate: 100_000 });
	});
	it("offers nothing where the window is single-priced, a plan, or a custom host", () => {
		const anthropic = {
			provider: "anthropic" as const,
			baseUrl: "https://api.anthropic.com/v1",
		};
		expect(
			apiContextWindowOption(anthropic, "claude-opus-5-5"),
		).toBeUndefined();
		expect(
			apiContextWindowOption(openrouter, "google/gemini-4-argon"),
		).toBeUndefined();
		expect(
			apiContextWindowOption(
				{ ...xai, subscription: { provider: "xai", status: "ready" } },
				"grok-4.7",
			),
		).toBeUndefined();
		expect(
			apiContextWindowOption(
				{ provider: "compatible", baseUrl: "https://gateway.example.com/v1" },
				"gpt-6.1-sol",
			),
		).toBeUndefined();
		// A direct id on another maker's key is not that maker's route.
		expect(apiContextWindowOption(xai, "gpt-6.1-sol")).toBeUndefined();
	});
	it("lists the option on the composer's route", () => {
		const [model] = availableConnectionModels(
			[
				{
					id: "c1",
					provider: "openai",
					label: "OpenAI",
					baseUrl: "https://api.openai.com/v1",
					models: [
						{
							id: "gpt-6.1-sol",
							label: "GPT-6.1 Sol",
							toolStreamingVerified: true,
						},
					],
					revision: "r1",
				},
			],
			[],
		);
		expect(model?.contextWindow).toMatchObject({
			standard: 1_050_000,
			alternate: 272_000,
		});
	});
});

describe("connection model speeds", () => {
	const xai = {
		provider: "compatible" as const,
		baseUrl: "https://api.x.ai/v1",
	};

	it("offers xAI's priority tier on its own API, as 2x price", () => {
		expect(connectionModelSpeeds(xai, "grok-4.7")).toEqual([
			{
				id: "fast",
				providers: ["xai/priority"],
				priceMultiple: 2,
				serviceTier: "priority",
			},
		]);
		expect(connectionModelSpeeds(xai, "grok-4.6")[0]?.serviceTier).toBe(
			"priority",
		);
		expect(connectionModelSpeeds(xai, "grok-4.20-0309-reasoning")).toEqual([]);
	});

	it("offers no direct speed elsewhere, and OpenRouter's as before", () => {
		expect(
			connectionModelSpeeds(
				{ provider: "compatible", baseUrl: "https://gateway.example/v1" },
				"grok-4.7",
			),
		).toEqual([]);
		expect(
			connectionModelSpeeds(
				{ provider: "openai", baseUrl: "https://api.openai.com/v1" },
				"gpt-6.1-sol",
			),
		).toEqual([]);
		expect(
			connectionModelSpeeds(
				{ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
				"x-ai/grok-4.7",
			)[0]?.providers,
		).toEqual(["xai/priority"]);
	});

	it("lists Fast on the Grok plan's models in the picker", () => {
		const [model] = availableConnectionModels(
			[
				{
					id: "11111111-1111-4111-8111-111111111111",
					provider: "compatible",
					label: "Grok plan",
					baseUrl: "https://api.x.ai/v1",
					models: [
						{ id: "grok-4.7", label: "grok-4.7", toolStreamingVerified: true },
					],
					revision: "r1",
					subscription: { provider: "xai", status: "ready" },
				},
			],
			[],
		);
		expect(model?.speeds).toEqual([{ id: "fast", priceMultiple: 2 }]);
	});
});
