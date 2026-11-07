import { afterEach, describe, expect, it, vi } from "vitest";
import {
	devAllowsAnyModel,
	isFreeOpenRouterModel,
	openRouterOfficialFetch,
} from "./openrouter-official";

function sent(fetch: ReturnType<typeof vi.fn>) {
	const init = fetch.mock.calls[0]?.[1] as RequestInit | undefined;
	return JSON.parse(String(init?.body));
}

it("pins a listed model to its maker's own providers with fallbacks off", async () => {
	const fetch = vi.fn(async () => new Response("{}"));
	await openRouterOfficialFetch(fetch)("https://openrouter.ai/api/v1/chat", {
		method: "POST",
		body: JSON.stringify({
			model: "google/gemini-3.8-flash",
			provider: { sort: "price" },
			messages: [],
		}),
	});
	expect(sent(fetch).provider).toEqual({
		sort: "price",
		only: ["google-ai-studio", "google-vertex"],
		allow_fallbacks: false,
	});
});

it("refuses a model that is not on the list before contacting OpenRouter", async () => {
	const fetch = vi.fn(async () => new Response("{}"));
	await expect(
		openRouterOfficialFetch(fetch)("https://openrouter.ai/api/v1/chat", {
			method: "POST",
			body: JSON.stringify({ model: "z-ai/glm-5.3-prime", messages: [] }),
		}),
	).rejects.toThrow("not an offered model");
	expect(fetch).not.toHaveBeenCalled();
});

it("pins a faster speed to the maker's own tiered endpoint", async () => {
	const fetch = vi.fn(async () => new Response("{}"));
	await openRouterOfficialFetch(fetch, "ultrafast")(
		"https://openrouter.ai/api/v1/chat",
		{
			method: "POST",
			body: JSON.stringify({ model: "openai/gpt-6.1-sol", messages: [] }),
		},
	);
	expect(sent(fetch).provider).toEqual({
		only: ["openai/ultrafast"],
		allow_fallbacks: false,
	});
});

it("refuses a speed the model's maker does not offer", async () => {
	const fetch = vi.fn(async () => new Response("{}"));
	await expect(
		openRouterOfficialFetch(fetch, "ultrafast")(
			"https://openrouter.ai/api/v1/chat",
			{
				method: "POST",
				body: JSON.stringify({ model: "openai/gpt-6-luna", messages: [] }),
			},
		),
	).rejects.toThrow("no ultrafast endpoint");
	expect(fetch).not.toHaveBeenCalled();
});

it("runs DeepSeek only on its approved US hosts with zero retention", async () => {
	const fetch = vi.fn(async () => new Response("{}"));
	await openRouterOfficialFetch(fetch)("https://openrouter.ai/api/v1/chat", {
		method: "POST",
		body: JSON.stringify({
			model: "deepseek/deepseek-v4.1-flash",
			messages: [],
		}),
	});
	expect(sent(fetch).provider).toEqual({
		only: ["fireworks/us", "together"],
		allow_fallbacks: false,
		zdr: true,
	});
});

describe("free models in development", () => {
	afterEach(() => vi.unstubAllEnvs());
	const send = (model: string, speed?: "ultrafast") => {
		const fetch = vi.fn(
			async (_url: RequestInfo | URL, _init?: RequestInit) =>
				new Response("{}"),
		);
		const body = JSON.stringify({ model, messages: [] });
		return {
			fetch,
			body,
			result: openRouterOfficialFetch(fetch, speed)(
				"https://openrouter.ai/api/v1/chat",
				{ method: "POST", body },
			),
		};
	};

	it("passes an unlisted :free model through unpinned when the dev flag is on", async () => {
		vi.stubEnv("YTIMESY_DEV_ALLOW_ANY_MODEL", "1");
		vi.stubEnv("YTIMESY_ENVIRONMENT", "development");
		const { fetch, body, result } = send("google/gemma-4-31b-it:free");
		await result;
		expect(fetch.mock.calls[0]?.[1]?.body).toBe(body);
	});

	it("still refuses an unlisted paid model with the dev flag on", async () => {
		vi.stubEnv("YTIMESY_DEV_ALLOW_ANY_MODEL", "1");
		const { fetch, result } = send("z-ai/glm-5.3-prime");
		await expect(result).rejects.toThrow("not an offered model");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("refuses a :free model without the flag, in production, or at a faster speed", async () => {
		vi.stubEnv("YTIMESY_DEV_ALLOW_ANY_MODEL", "");
		await expect(send("google/gemma-4-31b-it:free").result).rejects.toThrow(
			"not an offered model",
		);
		vi.stubEnv("YTIMESY_DEV_ALLOW_ANY_MODEL", "1");
		vi.stubEnv("YTIMESY_ENVIRONMENT", "production");
		await expect(send("google/gemma-4-31b-it:free").result).rejects.toThrow(
			"not an offered model",
		);
		vi.stubEnv("YTIMESY_ENVIRONMENT", "development");
		await expect(
			send("google/gemma-4-31b-it:free", "ultrafast").result,
		).rejects.toThrow("no ultrafast endpoint");
	});

	it("allows any model only in development", () => {
		expect(
			devAllowsAnyModel({
				YTIMESY_DEV_ALLOW_ANY_MODEL: "1",
				YTIMESY_ENVIRONMENT: "production",
			}),
		).toBe(false);
		expect(devAllowsAnyModel({ YTIMESY_DEV_ALLOW_ANY_MODEL: "1" })).toBe(false);
		expect(
			devAllowsAnyModel({
				YTIMESY_DEV_ALLOW_ANY_MODEL: "1",
				YTIMESY_ENVIRONMENT: "development",
			}),
		).toBe(true);
		expect(devAllowsAnyModel({})).toBe(false);
	});

	it("recognizes only maker/model:free ids", () => {
		expect(isFreeOpenRouterModel("nvidia/nemotron-3.5-super-vl:free")).toBe(
			true,
		);
		expect(isFreeOpenRouterModel("openai/gpt-6.1-sol")).toBe(false);
		expect(isFreeOpenRouterModel("openai/gpt-6.1-sol:nitro")).toBe(false);
		expect(isFreeOpenRouterModel("free:free")).toBe(false);
	});
});

it("lets the local runner use any model, unpinned, with OpenRouter's own routing", async () => {
	const fetch = vi.fn(async () => new Response("{}"));
	await openRouterOfficialFetch(
		fetch,
		undefined,
		true,
	)("https://openrouter.ai/api/v1/chat", {
		method: "POST",
		body: JSON.stringify({ model: "vendor/unlisted-model:free", messages: [] }),
	});
	expect(sent(fetch).model).toBe("vendor/unlisted-model:free");
	expect(sent(fetch).provider).toBeUndefined();
});
