export type AgentProviderId = "codex" | "api";

export const DEFAULT_COMPOSER_HARNESS_ID: AgentProviderId = "codex";

export type AgentProvider = {
	readonly id: AgentProviderId;
	readonly name: string;
	readonly signInMethod: string | null;
	readonly authorizeWith: string;
};

export const CODEX_PROVIDER: AgentProvider = {
	id: "codex",
	name: "Codex",
	signInMethod: "ChatGPT",
	authorizeWith: "OpenAI",
};

export const API_PROVIDER: AgentProvider = {
	id: "api",
	name: "API models",
	signInMethod: null,
	authorizeWith: "API connection",
};

export function offeredAgentProviders(): readonly AgentProvider[] {
	return [CODEX_PROVIDER, API_PROVIDER];
}

export function parseRuntimeId(value: string): AgentProviderId {
	if (value === "codex" || value === "api") return value;
	throw new Error("Unsupported runtime");
}

export function agentProviderById(id: AgentProviderId): AgentProvider {
	return id === "api" ? API_PROVIDER : CODEX_PROVIDER;
}
