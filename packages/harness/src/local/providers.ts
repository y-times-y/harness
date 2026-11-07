import type { ModelProvider } from "../domain/model-connection";

/** A model provider the local runner can reach with an API key. */
export type LocalProvider = {
	provider: ModelProvider;
	baseUrl: string;
	defaultModel: string;
	/** The environment variable that holds the API key. */
	keyEnv: string;
};

export const LOCAL_PROVIDERS = {
	anthropic: {
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com/v1",
		defaultModel: "claude-opus-5-5",
		keyEnv: "ANTHROPIC_API_KEY",
	},
	openai: {
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		defaultModel: "gpt-6.1-sol",
		keyEnv: "OPENAI_API_KEY",
	},
	google: {
		provider: "google",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		defaultModel: "gemini-3.8-flash",
		keyEnv: "GEMINI_API_KEY",
	},
	openrouter: {
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		defaultModel: "anthropic/claude-opus-5-5",
		keyEnv: "OPENROUTER_API_KEY",
	},
} as const satisfies Record<string, LocalProvider>;

export type LocalProviderName = keyof typeof LOCAL_PROVIDERS;

export function isLocalProvider(name: string): name is LocalProviderName {
	return name in LOCAL_PROVIDERS;
}

/** The provider whose API key is set, in the order above; null when none is. */
export function providerFromEnvironment(
	env: Readonly<Record<string, string | undefined>>,
): LocalProviderName | null {
	for (const [name, provider] of Object.entries(LOCAL_PROVIDERS))
		if (env[provider.keyEnv]) return name as LocalProviderName;
	return null;
}
