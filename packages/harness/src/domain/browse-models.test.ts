import { expect, it } from "vitest";
import {
	directModelProvider,
	matchesModelSearch,
	parseBrowseModels,
	recentModelGenerations,
	visibleModelChoices,
} from "./browse-models";
import { availableConnectionModels } from "./model-connection";

const now = 1_790_000_000;
it("searches model names, provider IDs, and provider names", () => {
	const model = { label: "Gemini 3.8 Flash", author: "google" };
	expect(matchesModelSearch(model, "gemini")).toBe(true);
	expect(matchesModelSearch(model, "Google")).toBe(true);
	expect(matchesModelSearch(model, "openai")).toBe(false);
});
it("does not hide eligible models behind an arbitrary default-list cap", () => {
	const models = Array.from({ length: 9 }, (_, index) => ({
		label: `Model ${index + 1}`,
		author: "openai",
	}));
	expect(visibleModelChoices(models, "")).toEqual(models);
	expect(visibleModelChoices(models, "Model 9")).toEqual([models[8]]);
	expect(visibleModelChoices(models, "OpenAI")).toHaveLength(9);
});
it("retains the latest three generations and all their variants", () => {
	const ids = [
		"openai/gpt-6.1-sol-pro",
		"openai/gpt-6.1-sol",
		"openai/gpt-6-luna-pro",
		"openai/gpt-6-luna",
		"openai/gpt-6.1-sol",
		"openai/gpt-6-astra",
		"openai/gpt-5.6-sol",
		"openai/gpt-5.5",
	];
	expect(
		recentModelGenerations(ids.map((id) => ({ id }))).map((m) => m.id),
	).toEqual(ids.slice(0, -1));
});
it("keeps Claude tiers independent, handles older version ordering, and preserves unknown IDs", () => {
	const ids = [
		"anthropic/claude-opus-5.5",
		"anthropic/claude-opus-5",
		"anthropic/claude-opus-4.6",
		"anthropic/claude-opus-4.5",
		"anthropic/claude-sonnet-4.5",
		"anthropic/claude-3-7-sonnet",
		"anthropic/claude-3.5-sonnet",
		"anthropic/claude-3-sonnet",
		"provider/custom",
	];
	expect(
		recentModelGenerations(ids.map((id) => ({ id }))).map((m) => m.id),
	).toEqual(
		ids.filter(
			(id) =>
				!["anthropic/claude-opus-4.5", "anthropic/claude-3-sonnet"].includes(
					id,
				),
		),
	);
});
it("keeps subscription access separate from direct API providers", () => {
	expect(directModelProvider("codex")).toBeNull();
	expect(directModelProvider("openai")).toBe("openai");
	expect(directModelProvider("google")).toBe("google");
	expect(directModelProvider("deepseek")).toBe("compatible");
	expect(directModelProvider("unknown")).toBeNull();
});
it("offers only listed models, with our labels, through the connection", () => {
	const id = "12345678-1234-4123-8123-123456789012";
	expect(
		availableConnectionModels(
			[
				{
					id,
					provider: "openrouter",
					label: "Personal",
					baseUrl: "https://openrouter.ai/api/v1",
					revision: "r",
					models: [
						{
							id: "google/gemini-3.8-flash",
							label: "Google: Model",
							toolStreamingVerified: true,
						},
						{
							id: "not-verified",
							label: "Other",
							toolStreamingVerified: false,
						},
						{
							id: "google/slow:batch",
							label: "Slow batch",
							toolStreamingVerified: false,
						},
					],
				},
			],
			[
				{
					id: "google/gemini-3.8-flash",
					label: "Model",
					author: "google",
					created: now,
				},
			],
		),
	).toEqual([
		{
			id: `api/${id}/google%2Fgemini-3.8-flash`,
			label: "Gemini 3.8 Flash · Personal",
			speeds: [{ id: "fast", priceMultiple: 1.8 }],
		},
	]);
});
it("a direct key unlocks only its own maker's listed models", () => {
	const id = "12345678-1234-4123-8123-123456789012";
	expect(
		availableConnectionModels(
			[
				{
					id,
					provider: "google",
					label: "Google key",
					baseUrl: "https://generativelanguage.googleapis.com/v1beta",
					revision: "r",
					models: [
						{
							id: "gemini-3.6-flash",
							label: "Gemini 3.6 Flash",
							toolStreamingVerified: false,
						},
						{
							id: "gemini-3.8-flash",
							label: "Gemini 3.8 Flash",
							toolStreamingVerified: false,
						},
						{
							id: "gemini-3.1-pro-preview",
							label: "Gemini 3.1 Pro Preview",
							toolStreamingVerified: false,
						},
					],
				},
			],
			[],
		).map((model) => model.label),
	).toEqual(["Gemini 3.8 Flash · Google key"]);
});
it("never offers a model the list does not name, even one a gateway just added", () => {
	const id = "12345678-1234-4123-8123-123456789012";
	expect(
		availableConnectionModels(
			[
				{
					id,
					provider: "openrouter",
					label: "Personal",
					baseUrl: "https://openrouter.ai/api/v1",
					revision: "r",
					models: [],
				},
			],
			[
				{
					id: "z-ai/glm-5.3-flashx",
					label: "GLM 5.3 FlashX",
					author: "z-ai",
					created: now,
				},
			],
		),
	).toEqual([]);
});

it("reads the gateway catalog's ids and context sizes without filtering it", () => {
	expect(
		parseBrowseModels({
			data: [
				{
					id: "openai/gpt-6.1-sol",
					name: "OpenAI: GPT-6 Sol",
					context_length: 400_000,
				},
				{ id: "vendor/audio", name: "Audio" },
				{ id: 42 },
			],
		}).map((model) => [model.id, model.contextWindow]),
	).toEqual([
		["openai/gpt-6.1-sol", 400_000],
		["vendor/audio", undefined],
	]);
	expect(() => parseBrowseModels({})).toThrow("unavailable");
});

it("reads whether the catalog lists image input, and leaves it unknown otherwise", () => {
	expect(
		parseBrowseModels({
			data: [
				{
					id: "vendor/vision",
					architecture: { input_modalities: ["text", "image"] },
				},
				{ id: "vendor/text", architecture: { input_modalities: ["text"] } },
				{ id: "vendor/unknown" },
			],
		}).map((model) => [model.id, model.imageInput]),
	).toEqual([
		["vendor/vision", true],
		["vendor/text", false],
		["vendor/unknown", undefined],
	]);
});
