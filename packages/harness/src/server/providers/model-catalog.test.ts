import { expect, it, vi } from "vitest";
import {
	discoverConnectionModels,
	parseConnectedModels,
} from "./model-catalog";

it("records every model the key can access once, without claiming tool support", () => {
	expect(
		parseConnectedModels("openrouter", {
			data: [
				{
					id: "vendor/code",
					name: "Code",
					supported_parameters: ["tools"],
					architecture: { output_modalities: ["text"] },
				},
				{
					id: "vendor/code",
					name: "Code",
					supported_parameters: ["tools"],
					architecture: { output_modalities: ["text"] },
				},
				{
					id: "vendor/audio",
					name: "Audio",
					supported_parameters: ["tools"],
					architecture: { output_modalities: ["text", "audio"] },
				},
				{
					id: "vendor/code:batch",
					name: "Code (batch)",
					supported_parameters: ["tools"],
					architecture: { output_modalities: ["text"] },
				},
				{ id: 42 },
			],
		}),
	).toEqual([
		{ id: "vendor/audio", label: "Audio", toolStreamingVerified: false },
		{ id: "vendor/code", label: "Code", toolStreamingVerified: false },
		{
			id: "vendor/code:batch",
			label: "Code (batch)",
			toolStreamingVerified: false,
		},
	]);
});
it("filters Google embedding-only models", () => {
	expect(
		parseConnectedModels("google", {
			models: [
				{
					name: "models/gemini-chat",
					displayName: "Chat",
					supportedGenerationMethods: ["generateContent"],
				},
				{ name: "models/embed", supportedGenerationMethods: ["embedContent"] },
			],
		}),
	).toEqual([
		{ id: "gemini-chat", label: "Chat", toolStreamingVerified: false },
	]);
});
it("follows pagination and authenticates using the provider header", async () => {
	const fetch = vi
		.fn<typeof globalThis.fetch>()
		.mockResolvedValueOnce(
			Response.json({
				data: [{ id: "claude-first" }],
				has_more: true,
				last_id: "claude-first",
			}),
		)
		.mockResolvedValueOnce(
			Response.json({ data: [{ id: "claude-second" }], has_more: false }),
		);
	const result = await discoverConnectionModels(
		{
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com/v1",
			apiKey: "fixture-key",
		},
		fetch,
	);
	expect(result.map((row) => row.id)).toEqual([
		"claude-first",
		"claude-second",
	]);
	expect(fetch.mock.calls[0][1]?.headers).toMatchObject({
		"x-api-key": "fixture-key",
	});
	expect(String(fetch.mock.calls[1][0])).toContain("after_id=claude-first");
});
it("does not expose provider errors that might echo credentials", async () => {
	const fetch = vi
		.fn<typeof globalThis.fetch>()
		.mockResolvedValue(new Response("secret-key-fixture", { status: 401 }));
	await expect(
		discoverConnectionModels(
			{
				provider: "openai",
				baseUrl: "https://api.openai.com/v1",
				apiKey: "secret-key-fixture",
			},
			fetch,
		),
	).rejects.toThrow("HTTP 401");
});
