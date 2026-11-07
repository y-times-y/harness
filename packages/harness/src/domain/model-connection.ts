import { z } from "zod";
import {
	API_MODEL_LIST,
	type ApiModelSpeed,
	apiLongContextTier,
	apiModelSpeeds,
	directApiModelSpeeds,
} from "./api-model-list";
import { type BrowseModel, DIRECT_MODEL_ENDPOINTS } from "./browse-models";
import {
	type ListedContextWindow,
	listedContextWindow,
} from "./context-window-option";
import { knownModelLimits } from "./model-context-windows";
import type { XaiSubscriptionStatus } from "./xai-subscription";

export const modelProvider = z.enum([
	"openai",
	"anthropic",
	"google",
	"openrouter",
	"compatible",
]);
export type ModelProvider = z.infer<typeof modelProvider>;
export const MODEL_PROVIDERS: Record<
	ModelProvider,
	{ label: string; baseUrl: string | null }
> = {
	openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1" },
	anthropic: { label: "Anthropic", baseUrl: "https://api.anthropic.com/v1" },
	google: {
		label: "Google Gemini",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
	},
	openrouter: { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
	compatible: { label: "OpenAI-compatible endpoint", baseUrl: null },
};

/** True when the connection talks to its provider's own API, not a proxy or custom host. */
export function officialProviderEndpoint(connection: {
	provider: ModelProvider;
	baseUrl: string;
}): boolean {
	const official = MODEL_PROVIDERS[connection.provider]?.baseUrl;
	if (!official || !connection.baseUrl) return false;
	try {
		return new URL(connection.baseUrl).origin === new URL(official).origin;
	} catch {
		return false;
	}
}

export function publicModelEndpoint(value: string): string {
	const url = new URL(value);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		(url.port && url.port !== "443")
	) {
		throw new Error(
			"Use a public HTTPS base URL without credentials, query parameters, or a custom port.",
		);
	}
	return url.href.replace(/\/+$/, "");
}

export const modelConnectionInput = z
	.object({
		id: z.uuid().optional(),
		provider: modelProvider,
		label: z.string().trim().min(1).max(80),
		apiKey: z.string().trim().min(8).max(4096),
		baseUrl: z.string().trim().max(2048).optional(),
	})
	.strict()
	.transform((input) => ({
		...input,
		baseUrl: publicModelEndpoint(
			MODEL_PROVIDERS[input.provider].baseUrl ?? input.baseUrl ?? "",
		),
	}));

export type ConnectedModel = {
	readonly id: string;
	readonly label: string;
	readonly toolStreamingVerified: boolean;
	readonly contextWindow?: number;
};
export type PublicModelConnection = {
	readonly id: string;
	readonly provider: ModelProvider;
	readonly label: string;
	readonly baseUrl: string;
	readonly models: readonly ConnectedModel[];
	readonly revision: string;
	/**
	 * Set on a prepaid plan signed in with OAuth (SuperGrok) rather than an
	 * API key: its status, and why it waits for the user when it does.
	 */
	readonly subscription?: {
		readonly provider: "xai";
		readonly status: XaiSubscriptionStatus;
	};
};

type ApiModelReasoning = {
	readonly levels: readonly [
		{ id: string; label: string },
		...{ id: string; label: string }[],
	];
	readonly defaultLevelId: string;
};

const reasoningLabels: Record<string, string> = {
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Extra high",
	max: "Max",
};

/** Effort levels the API runtime sends, per model family; null when none apply. */
export function apiModelReasoning(
	provider: ModelProvider,
	modelId: string,
): ApiModelReasoning | null {
	const family = provider === "openrouter" ? modelId.split("/")[0] : provider;
	const ids =
		family === "openai"
			? ["low", "medium", "high", "xhigh"]
			: family === "anthropic"
				? ["low", "medium", "high", "xhigh", "max"]
				: null;
	if (!ids) return null;
	const [first, ...rest] = ids.map((id) => ({
		id,
		label: reasoningLabels[id] ?? id,
	}));
	return { levels: [first, ...rest], defaultLevelId: "medium" };
}

/**
 * The second window an API route offers: where a maker prices a request
 * higher past a prompt size (OpenAI past 272K, xAI past 200K, Haiku 5.5 past
 * 100K), the route keeps its full window by default,
 * and staying under that size is the opt-in choice.
 * Only on the maker's own API or OpenRouter (which bills the maker's tiers),
 * never on a plan sign-in (the Grok plan documents no such tier) or a
 * custom endpoint.
 */
export function apiContextWindowOption(
	connection: {
		readonly provider: ModelProvider;
		readonly baseUrl: string;
		readonly subscription?: unknown;
	},
	modelId: string,
): ListedContextWindow | undefined {
	if (connection.subscription) return undefined;
	const tier = apiLongContextTier(modelId);
	if (!tier) return undefined;
	const official =
		connection.provider === "openrouter" ||
		officialProviderEndpoint(connection) ||
		(connection.provider === "compatible" &&
			sameOrigin(connection.baseUrl, DIRECT_MODEL_ENDPOINTS["x-ai"]));
	if (!official || !officialRouteProvider(connection.provider, modelId))
		return undefined;
	const full = knownModelLimits(modelId)?.contextWindow;
	if (!full || full <= tier.threshold) return undefined;
	return listedContextWindow({
		standard: full,
		alternate: tier.threshold,
		note: tier.note,
	});
}

/** An OpenRouter id names its maker; a direct id must match the connection's maker. */
function officialRouteProvider(provider: ModelProvider, modelId: string) {
	if (provider === "openrouter") return modelId.includes("/");
	const entry = API_MODEL_LIST.find((model) => model.directId === modelId);
	if (!entry) return false;
	return provider === "compatible"
		? entry.author === "x-ai"
		: entry.author === provider;
}

function sameOrigin(a: string, b: string | undefined) {
	if (!b) return false;
	try {
		return new URL(a).origin === new URL(b).origin;
	} catch {
		return false;
	}
}

export function modelRouteId(connectionId: string, modelId: string): string {
	return `api/${connectionId}/${encodeURIComponent(modelId)}`;
}

/**
 * The faster speeds a model offers on a connection: the maker's tiered
 * endpoints through OpenRouter, or xAI's priority tier on its own API (a key
 * or the Grok plan). Other direct connections offer none.
 */
export function connectionModelSpeeds(
	connection: { readonly provider: ModelProvider; readonly baseUrl: string },
	modelId: string,
): readonly ApiModelSpeed[] {
	if (connection.provider === "openrouter") return apiModelSpeeds(modelId);
	return isXaiDirectEndpoint(connection.baseUrl)
		? directApiModelSpeeds(modelId)
		: [];
}

/** xAI's own API, where a speed is a `service_tier` on the request. */
export function isXaiDirectEndpoint(baseUrl: string) {
	try {
		return (
			new URL(baseUrl).origin ===
			new URL(DIRECT_MODEL_ENDPOINTS["x-ai"] as string).origin
		);
	} catch {
		return false;
	}
}

export function availableConnectionModels(
	connections: readonly PublicModelConnection[],
	browseModels: readonly BrowseModel[],
) {
	return connections.flatMap((connection) =>
		connectionModels(connection, browseModels).map((model) => {
			const reasoning = apiModelReasoning(connection.provider, model.id);
			const speeds = connectionModelSpeeds(connection, model.id).map(
				({ id, priceMultiple }) => ({ id, priceMultiple }),
			);
			const contextWindow = apiContextWindowOption(connection, model.id);
			return {
				id: modelRouteId(connection.id, model.id),
				label: `${model.label} · ${connection.label}`,
				...(reasoning ? { reasoning } : {}),
				...(speeds.length ? { speeds } : {}),
				...(contextWindow ? { contextWindow } : {}),
			};
		}),
	);
}

/** The picker section for models from a user's own OpenAI-compatible endpoint. */
export const CUSTOM_SECTION = "custom";

/**
 * A user's own OpenAI-compatible endpoint (a company gateway, a self-hosted
 * model), as opposed to a maker or gateway we know. Its models are offered as
 * the endpoint lists them: the user chose that host, so the curated list does
 * not apply. A known maker's or gateway's host is never custom, so it cannot
 * bypass the list.
 */
export function isCustomConnection(connection: {
	provider: ModelProvider;
	baseUrl: string;
}): boolean {
	if (connection.provider !== "compatible") return false;
	const known = [
		...Object.values(MODEL_PROVIDERS).flatMap((row) =>
			row.baseUrl ? [row.baseUrl] : [],
		),
		...Object.values(DIRECT_MODEL_ENDPOINTS),
	].map((url) => new URL(url).hostname);
	try {
		return !known.includes(new URL(connection.baseUrl).hostname);
	} catch {
		return false;
	}
}

/** The maker whose own key this connection is, or null for a gateway or unknown host. */
export function directAuthor(connection: {
	provider: ModelProvider;
	baseUrl: string;
}): string | null {
	if (connection.provider === "compatible")
		return (
			Object.entries(DIRECT_MODEL_ENDPOINTS).find(
				([, endpoint]) => endpoint === connection.baseUrl,
			)?.[0] ?? null
		);
	return connection.provider === "openrouter" ? null : connection.provider;
}

/**
 * The listed models this connection serves, in list order. Only API_MODEL_LIST
 * decides what is offered; the connection's catalog (and, for OpenRouter, the
 * current public catalog) only confirms the key can use an entry.
 */
export function connectionModels(
	connection: PublicModelConnection,
	browseModels: readonly BrowseModel[],
): readonly ConnectedModel[] {
	if (isCustomConnection(connection)) return connection.models;
	const saved = new Map(connection.models.map((model) => [model.id, model]));
	const browsed = new Map(browseModels.map((model) => [model.id, model]));
	const author = directAuthor(connection);
	return API_MODEL_LIST.flatMap((entry) => {
		const id =
			connection.provider === "openrouter"
				? entry.openRouterId
				: entry.author === author
					? entry.directId
					: undefined;
		if (!id) return [];
		const offered =
			saved.has(id) ||
			(connection.provider === "openrouter" && browsed.has(id));
		if (!offered) return [];
		return [
			{
				id,
				label: entry.label,
				toolStreamingVerified: saved.get(id)?.toolStreamingVerified ?? false,
				...((browsed.get(id)?.contextWindow ?? saved.get(id)?.contextWindow)
					? {
							contextWindow:
								browsed.get(id)?.contextWindow ?? saved.get(id)?.contextWindow,
						}
					: {}),
			},
		];
	});
}

export function parseModelRouteId(
	value: string,
): { connectionId: string; modelId: string } | null {
	const match = /^api\/([^/]+)\/(.+)$/.exec(value);
	if (!match || !z.uuid().safeParse(match[1]).success) return null;
	try {
		const modelId = decodeURIComponent(match[2]);
		return modelId.length > 0 && modelId.length <= 512
			? { connectionId: match[1], modelId }
			: null;
	} catch {
		return null;
	}
}
