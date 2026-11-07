import type { ModelProvider } from "./model-connection";

/** What an API route asks for when the turn names no output limit. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
/**
 * Claude's current models accept up to 128K output tokens (streamed, which
 * the harness always is); at high effort adaptive thinking spends most of a
 * response's budget, so 8K truncated long steps. 64K leaves room for thinking
 * plus a whole-file write.
 */
export const CLAUDE_MAX_OUTPUT_TOKENS = 64_000;

/**
 * The output limit for a route with none set: 64K for Claude 4.5 and later
 * (direct or through OpenRouter), 32K for Opus 4 and 4.1 (their maximum),
 * the general 8K otherwise, including older Claude models whose maximum is
 * lower.
 */
export function defaultMaxOutputTokens(
	provider: ModelProvider,
	modelId: string,
) {
	const id =
		provider === "anthropic"
			? modelId
			: provider === "openrouter"
				? (/^anthropic\/(.+)$/.exec(modelId)?.[1] ?? null)
				: null;
	if (!id) return DEFAULT_MAX_OUTPUT_TOKENS;
	// claude-opus-4-1, claude-opus-5.5 and family-last ids (claude-3-7-sonnet) all parse.
	const match = /^claude-(?:[a-z]+-)?(\d+)(?:[.-](\d{1,2}))?(?:$|[^\d])/.exec(
		id,
	);
	if (!match) return DEFAULT_MAX_OUTPUT_TOKENS;
	const major = Number(match[1]);
	const minor = Number(match[2] ?? 0);
	if (major >= 5) return CLAUDE_MAX_OUTPUT_TOKENS;
	if (major === 4 && /opus/.test(id) && minor <= 1) return 32_000;
	if (major === 4) return CLAUDE_MAX_OUTPUT_TOKENS;
	return DEFAULT_MAX_OUTPUT_TOKENS;
}
