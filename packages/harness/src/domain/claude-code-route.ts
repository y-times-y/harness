import type { ListedModel } from "./listed-model";

/**
 * "Claude Code": chats that run through the Claude Agent SDK on the chat's
 * own VM, billed to the user's Claude Pro/Max subscription (the token from
 * `claude setup-token`). The chat's runtime stays "api" (same transcript,
 * subagents and checkout plumbing); the route says which harness runs it.
 */
const ROUTE_PREFIX = "claude-code/";
const REVISION_PREFIX = "claude-code:v1:";

/** The connection key routes, failover and preferences use for the subscription. */
export const CLAUDE_CODE_KEY = "claude-code";
/** How the chat names the connection. */
export const CLAUDE_CODE_LABEL = "Claude Agent";

/** The models a Claude subscription covers, as the SDK's `--model` names them. */
export const CLAUDE_CODE_MODELS: readonly ListedModel[] = [
	{ id: "claude-opus-5-5", label: "Claude Opus 5.5" },
	{ id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
	{ id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
];

/** These models as the OpenRouter ids failover compares (model-failover.ts). */
export const CLAUDE_CODE_MODEL_EQUIVALENTS: Readonly<Record<string, string>> = {
	"claude-opus-5-5": "anthropic/claude-opus-5.5",
	"claude-sonnet-5-5": "anthropic/claude-sonnet-5.5",
	"claude-haiku-5-5": "anthropic/claude-haiku-5.5",
};

/** The feature switch, for the web app and the edge alike (off unless "1"). */
export function claudeSubscriptionEnabled(
	env: Readonly<Record<string, string | undefined>> = process.env,
) {
	return env.YTIMESY_CLAUDE_SUBSCRIPTION_ENABLED === "1";
}

export function claudeCodeRouteId(modelId: string) {
	return `${ROUTE_PREFIX}${modelId}`;
}

/** The Claude Code model a composer route names, or null for any other route. */
export function parseClaudeCodeRouteId(value: string): string | null {
	if (!value.startsWith(ROUTE_PREFIX)) return null;
	const modelId = value.slice(ROUTE_PREFIX.length);
	return CLAUDE_CODE_MODELS.some((model) => model.id === modelId)
		? modelId
		: null;
}

export function isClaudeCodeRoute(value: string) {
	return value.startsWith(ROUTE_PREFIX);
}

/** The composer's model list for a connected subscription. */
export function claudeCodeListedModels(): ListedModel[] {
	return CLAUDE_CODE_MODELS.map((model) => ({
		...model,
		id: claudeCodeRouteId(model.id),
	}));
}

/**
 * A turn's connection revision (api_turn.connection_revision with no
 * connection id): this prefix, never the ChatGPT plan's, so a turn
 * can never be served by the wrong subscription.
 */
export function claudeCodeTurnRevision() {
	return `${REVISION_PREFIX}${JSON.stringify({})}`;
}

export function isClaudeCodeRevision(revision: string | null | undefined) {
	return typeof revision === "string" && revision.startsWith(REVISION_PREFIX);
}

export function claudeCodeModelLabel(modelId: string) {
	return (
		CLAUDE_CODE_MODELS.find((model) => model.id === modelId)?.label ?? modelId
	);
}

/**
 * The connected Claude subscription's models that match a model-picker
 * search, so search finds the usable route, not only the API-key one.
 */
export function claudeCodeSearchMatches<T extends { readonly label: string }>(
	models: readonly T[],
	search: string,
): T[] {
	const term = search.trim().toLowerCase();
	if (!term) return [];
	return models.filter((model) =>
		[model.label, "anthropic", "claude code", "claude subscription"].some(
			(text) => text.toLowerCase().includes(term),
		),
	);
}

/** The API-list ids (OpenRouter's) of subscription routes, so search shows no locked copy of them. */
export function claudeCodeCoveredOpenRouterIds(
	models: readonly { readonly id: string }[],
): string[] {
	return models.flatMap((model) => {
		const id = parseClaudeCodeRouteId(model.id);
		const equivalent = id ? CLAUDE_CODE_MODEL_EQUIVALENTS[id] : undefined;
		return equivalent ? [equivalent] : [];
	});
}
