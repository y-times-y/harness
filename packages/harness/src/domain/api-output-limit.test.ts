import { describe, expect, it } from "vitest";
import {
	CLAUDE_MAX_OUTPUT_TOKENS,
	DEFAULT_MAX_OUTPUT_TOKENS,
	defaultMaxOutputTokens,
} from "./api-output-limit";

describe("defaultMaxOutputTokens", () => {
	it("gives current Claude models 64K, direct or through OpenRouter", () => {
		for (const id of [
			"claude-opus-5-5",
			"claude-sonnet-5-5",
			"claude-haiku-5-5",
			"claude-fable-5-1",
			"claude-opus-5",
			"claude-sonnet-4-5",
			"claude-sonnet-4-20250514",
		])
			expect(defaultMaxOutputTokens("anthropic", id)).toBe(
				CLAUDE_MAX_OUTPUT_TOKENS,
			);
		expect(
			defaultMaxOutputTokens("openrouter", "anthropic/claude-opus-5.5"),
		).toBe(CLAUDE_MAX_OUTPUT_TOKENS);
	});

	it("stays within older Claude models' maximum", () => {
		expect(
			defaultMaxOutputTokens("anthropic", "claude-opus-4-1-20250805"),
		).toBe(32_000);
		expect(defaultMaxOutputTokens("anthropic", "claude-opus-4-20250514")).toBe(
			32_000,
		);
		expect(
			defaultMaxOutputTokens("anthropic", "claude-3-7-sonnet-20250219"),
		).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
	});

	it("keeps the general default for other providers and unknown ids", () => {
		expect(defaultMaxOutputTokens("openai", "gpt-6.1-sol")).toBe(
			DEFAULT_MAX_OUTPUT_TOKENS,
		);
		expect(defaultMaxOutputTokens("google", "gemini-3.8-flash")).toBe(
			DEFAULT_MAX_OUTPUT_TOKENS,
		);
		expect(
			defaultMaxOutputTokens("openrouter", "google/gemini-3.8-flash"),
		).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
		expect(defaultMaxOutputTokens("anthropic", "my-proxy-model")).toBe(
			DEFAULT_MAX_OUTPUT_TOKENS,
		);
	});
});
