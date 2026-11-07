import { expect, it, vi } from "vitest";
import { preservedThinkingFetch } from "./preserved-thinking";

it.each([
	["https://api.z.ai/api/paas/v4", "glm-5.3", { clear_thinking: false }],
	["https://api.moonshot.ai/v1", "kimi-k2.6", { keep: "all" }],
])(
	"sets documented preservation controls for %s",
	async (baseUrl, model, thinking) => {
		const fetch = vi.fn(
			async (
				_url: Parameters<typeof globalThis.fetch>[0],
				_init?: RequestInit,
			) => Response.json({}),
		);
		await preservedThinkingFetch(baseUrl, fetch)(
			`${baseUrl}/chat/completions`,
			{
				body: JSON.stringify({
					model,
					messages: [],
					thinking: { type: "enabled" },
				}),
			},
		);
		expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).thinking).toEqual({
			type: "enabled",
			...thinking,
		});
	},
);

it("leaves unknown endpoints and other Kimi model settings alone", async () => {
	const fetch = vi.fn(
		async (_url: Parameters<typeof globalThis.fetch>[0], _init?: RequestInit) =>
			Response.json({}),
	);
	const init = { body: JSON.stringify({ model: "kimi-k3", messages: [] }) };
	await preservedThinkingFetch("https://custom.example/v1", fetch)(
		"https://custom.example/v1/chat/completions",
		init,
	);
	expect(fetch.mock.calls[0][1]).toBe(init);
});
