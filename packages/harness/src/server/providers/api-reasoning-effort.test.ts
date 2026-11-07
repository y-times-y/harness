import { expect, it } from "vitest";
import {
	apiReasoningEffort,
	providerOptionsEffort,
	withProviderOptionsEffort,
	withReasoningEffort,
} from "./api-reasoning-effort";

it("accepts only provider effort levels", () => {
	expect(apiReasoningEffort("max")).toBe("max");
	expect(apiReasoningEffort("minimal")).toBe("low");
	expect(apiReasoningEffort("extreme")).toBeNull();
	expect(apiReasoningEffort(undefined)).toBeNull();
});

const empty: { providerOptions?: unknown } = {};

it("sends the requested effort in each provider's own option without dropping cache settings", () => {
	const settings = {
		system: "Stable instructions",
		providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
	};
	expect(withReasoningEffort(settings, "anthropic", "max")).toEqual({
		system: "Stable instructions",
		providerOptions: {
			anthropic: { cacheControl: { type: "ephemeral" }, effort: "max" },
		},
	});
	expect(
		withReasoningEffort(empty, "openrouter", "max").providerOptions,
	).toEqual({
		openrouter: { reasoning: { effort: "max" } },
	});
	expect(withReasoningEffort(empty, "openai", "high").providerOptions).toEqual({
		openai: { reasoningEffort: "high" },
	});
});

it("leaves settings untouched without a valid effort or for unsupported providers", () => {
	const settings = { providerOptions: { google: { a: 1 } } };
	expect(withReasoningEffort(settings, "anthropic", null)).toBe(settings);
	expect(withReasoningEffort(settings, "google", "max")).toBe(settings);
});

it("reads and replaces the effort a request's provider options name", () => {
	const options = {
		openai: { reasoningEffort: "max", store: false },
		google: { a: 1 },
	};
	expect(providerOptionsEffort(options)).toBe("max");
	expect(providerOptionsEffort({ anthropic: { effort: "xhigh" } })).toBe(
		"xhigh",
	);
	expect(
		providerOptionsEffort({ openrouter: { reasoning: { effort: "high" } } }),
	).toBe("high");
	expect(providerOptionsEffort({ google: { a: 1 } })).toBeUndefined();
	expect(providerOptionsEffort(undefined)).toBeUndefined();
	expect(withProviderOptionsEffort(options, "high")).toEqual({
		openai: { reasoningEffort: "high", store: false },
		google: { a: 1 },
	});
	expect(options.openai.reasoningEffort).toBe("max");
});
