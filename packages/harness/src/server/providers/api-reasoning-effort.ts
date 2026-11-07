import type { ModelProvider } from "../../domain/model-connection";

const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof EFFORT_LEVELS)[number];

/** Unknown levels are ignored rather than guessed; the provider default then applies. */
export function apiReasoningEffort(value: string | undefined) {
	const level = value === "minimal" ? "low" : value;
	return EFFORT_LEVELS.find((candidate) => candidate === level) ?? null;
}

type ProviderOptions = Record<string, Record<string, unknown>>;

/**
 * Without an explicit effort, models run at their own default (Claude Opus 5.5
 * defaults to medium), so a requested level must reach every provider.
 */
export function withReasoningEffort<T extends { providerOptions?: unknown }>(
	settings: T,
	provider: ModelProvider,
	effort: ReasoningEffort | null,
): T {
	if (!effort) return settings;
	const options = (settings.providerOptions ?? {}) as ProviderOptions;
	const merge = (key: string, value: Record<string, unknown>) => ({
		...settings,
		providerOptions: { ...options, [key]: { ...options[key], ...value } },
	});
	switch (provider) {
		case "anthropic":
			return merge("anthropic", { effort });
		case "openrouter":
			// OpenRouter passes Claude effort through unchanged, including "max".
			return merge("openrouter", { reasoning: { effort } });
		case "openai":
			return merge("openai", { reasoningEffort: effort });
		default:
			return settings;
	}
}

/**
 * The effort a request's provider options name (OpenAI's reasoningEffort,
 * Anthropic's effort or OpenRouter's reasoning.effort); undefined when none.
 */
export function providerOptionsEffort(
	options: ProviderOptions | undefined,
): string | undefined {
	const named = [
		options?.openai?.reasoningEffort,
		options?.anthropic?.effort,
		(options?.openrouter?.reasoning as Record<string, unknown> | undefined)
			?.effort,
	].find((value) => typeof value === "string");
	return named as string | undefined;
}

/** The provider options with every effort they name set to `effort`; others unchanged. */
export function withProviderOptionsEffort<T extends ProviderOptions>(
	options: T,
	effort: string,
): T {
	const changed: ProviderOptions = { ...options };
	if (options.openai && "reasoningEffort" in options.openai)
		changed.openai = { ...options.openai, reasoningEffort: effort };
	if (options.anthropic && "effort" in options.anthropic)
		changed.anthropic = { ...options.anthropic, effort };
	const reasoning = options.openrouter?.reasoning as
		| Record<string, unknown>
		| undefined;
	if (reasoning && "effort" in reasoning)
		changed.openrouter = {
			...options.openrouter,
			reasoning: { ...reasoning, effort },
		};
	return changed as T;
}
