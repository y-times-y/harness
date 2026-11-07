import { listedOpenRouterId } from "./api-model-list";
import type { ApiTokenUsage, LongContextUsage } from "./api-token-usage";
import { parseModelRouteId } from "./model-connection";

/** USD per million tokens. Cache prices default to the input price when unknown. */
export type TokenPrices = {
	readonly input: number;
	readonly output: number;
	/** Cached input (a cache hit). */
	readonly cacheRead?: number;
	/** Writing the cache (Anthropic's 5-minute write; OpenAI's listed cache write). */
	readonly cacheWrite?: number;
};

export type ModelPrice = TokenPrices & {
	/**
	 * The provider's long-context tier: a request whose input exceeds
	 * `aboveInputTokens` is billed at these prices for all of its tokens.
	 * Applied per request from the usage's `longContext` part, which the
	 * agent loop records per model call (src/server/services/model-agent-loop.ts).
	 */
	readonly longContext?: TokenPrices & { readonly aboveInputTokens: number };
};

/**
 * List prices we know (per million tokens, standard tier, accessed
 * 2026-10-19). A model missing here has no dollar estimate: its cost shows
 * as tokens only, never as a guess. Models served through OpenRouter report
 * their own cost, which wins over this.
 *
 * Sources:
 * - OpenAI: https://developers.openai.com/api/docs/pricing (standard tier;
 *   long context is >272K input tokens per request).
 * - Anthropic: https://platform.claude.com/docs/en/about-claude/pricing
 *   (cache write = 5-minute write; Sonnet/Opus 5.5 have no long-context
 *   premium; Haiku 5.5 has a higher tier above 100K prompt tokens).
 * - Google: https://ai.google.dev/gemini-api/docs/pricing (paid tier; no
 *   cache-write price, context-cache storage is billed per hour and not
 *   modelled here; scheduled increases in SCHEDULED_PRICE_CHANGES).
 * - DeepSeek V4.1 Flash: OpenRouter endpoints list for our pinned US hosts
 *   (https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints):
 *   fireworks/us $0.45/$1.80/$0.009, together $0.30/$1.20/$0.006; the
 *   dearer host is used so an estimate never understates.
 * - DeepSeek V4 Pro: DeepSeek's official peak price
 *   (https://api-docs.deepseek.com/quick_start/pricing); OpenRouter's Together
 *   listing was not visible, so this is a reference price (low confidence).
 * - Kimi K3: https://platform.kimi.ai/docs/pricing/chat (5-minute cache write).
 * - GLM 5.3: https://docs.z.ai/guides/overview/pricing.
 */
export const KNOWN_MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
	"openai/gpt-6.1-sol": {
		input: 2,
		output: 10,
		cacheRead: 0.1,
		cacheWrite: 2.5,
		longContext: {
			aboveInputTokens: 272_000,
			input: 4,
			output: 15,
			cacheRead: 0.2,
			cacheWrite: 5,
		},
	},
	"openai/gpt-6-sol": {
		input: 2,
		output: 10,
		cacheRead: 0.2,
		cacheWrite: 2.5,
		longContext: {
			aboveInputTokens: 272_000,
			input: 4,
			output: 15,
			cacheRead: 0.4,
			cacheWrite: 5,
		},
	},
	"openai/gpt-6-astra": {
		input: 10,
		output: 50,
		cacheRead: 1,
		cacheWrite: 12.5,
		longContext: {
			aboveInputTokens: 272_000,
			input: 20,
			output: 75,
			cacheRead: 2,
			cacheWrite: 25,
		},
	},
	"openai/gpt-6-luna": {
		input: 0.1,
		output: 0.5,
		cacheRead: 0.01,
		cacheWrite: 0.125,
		longContext: {
			aboveInputTokens: 272_000,
			input: 0.2,
			output: 0.75,
			cacheRead: 0.02,
			cacheWrite: 0.25,
		},
	},
	"anthropic/claude-opus-5.5": {
		input: 4,
		output: 20,
		cacheRead: 0.2,
		cacheWrite: 5,
	},
	"anthropic/claude-sonnet-5.5": {
		input: 2,
		output: 10,
		cacheRead: 0.1,
		cacheWrite: 2.5,
	},
	"anthropic/claude-haiku-5.5": {
		input: 0.1,
		output: 0.5,
		cacheRead: 0.01,
		cacheWrite: 0.125,
		longContext: {
			aboveInputTokens: 100_000,
			input: 0.5,
			output: 2.5,
			cacheRead: 0.05,
			cacheWrite: 0.625,
		},
	},
	// Introductory prices; see SCHEDULED_PRICE_CHANGES.
	"google/gemini-3.8-flash": { input: 0.75, output: 3.75, cacheRead: 0.075 },
	"google/gemini-4-argon": { input: 2, output: 10, cacheRead: 0.1 },
	"deepseek/deepseek-v4.1-flash": {
		input: 0.45,
		output: 1.8,
		cacheRead: 0.009,
	},
	"deepseek/deepseek-v4-pro-0813": {
		input: 1.32,
		output: 3.96,
		cacheRead: 0.044,
	},
	"moonshotai/kimi-k3": {
		input: 3,
		output: 15,
		cacheRead: 0.3,
		cacheWrite: 3,
	},
	"z-ai/glm-5.3": { input: 1.4, output: 4.4, cacheRead: 0.26 },
};

/**
 * Announced list-price changes (same Google page): each applies from its
 * date (UTC) on, in place of KNOWN_MODEL_PRICES.
 */
export const SCHEDULED_PRICE_CHANGES: Readonly<
	Record<
		string,
		readonly { readonly from: string; readonly price: ModelPrice }[]
	>
> = {
	"google/gemini-3.8-flash": [
		{
			from: "2027-01-01",
			price: { input: 1.5, output: 7.5, cacheRead: 0.15 },
		},
	],
	"google/gemini-4-argon": [
		{ from: "2026-12-01", price: { input: 4, output: 20, cacheRead: 0.2 } },
	],
};

function priceAt(id: string, at: number): ModelPrice | null {
	const base = KNOWN_MODEL_PRICES[id];
	if (!base) return null;
	const changes = (SCHEDULED_PRICE_CHANGES[id] ?? [])
		.filter((change) => Date.parse(`${change.from}T00:00:00Z`) <= at)
		.sort((a, b) => b.from.localeCompare(a.from));
	return changes[0]?.price ?? base;
}

/**
 * Amazon Bedrock bills OpenAI models at OpenAI's list price through a global
 * inference profile (`global.openai.gpt-…`) and 10% above it through a
 * geographic one (`us.openai.gpt-…`); cache writes are billed at the listed
 * cache-write price. The foundation id (`openai.gpt-…`, in-Region on the
 * bedrock-mantle endpoint) is priced as geographic too: AWS prices global
 * below in-Region for these models and publishes no exact in-Region premium.
 */
const BEDROCK_REGIONAL_OPENAI =
	/^(?:(?:us|us-gov|eu|apac|jp|au|ca)\.)?openai\.gpt-/;
export const BEDROCK_REGIONAL_PREMIUM = 1.1;

function scaledTokenPrices<T extends TokenPrices>(price: T, factor: number): T {
	const scale = (value: number | undefined) =>
		value === undefined ? undefined : value * factor;
	return {
		...price,
		input: price.input * factor,
		output: price.output * factor,
		...(price.cacheRead === undefined
			? {}
			: { cacheRead: scale(price.cacheRead) }),
		...(price.cacheWrite === undefined
			? {}
			: { cacheWrite: scale(price.cacheWrite) }),
	};
}

/** The list price of a route, `codex:` slug, direct id or OpenRouter id; null when unknown. */
export function modelPrice(
	modelId: string,
	at = Date.now(),
): ModelPrice | null {
	const id = pricedModelId(modelId);
	for (const candidate of [
		id,
		listedOpenRouterId(id),
		`openai/${id}`,
		`anthropic/${id}`,
		`google/${id}`,
	])
		if (candidate) {
			const price = priceAt(candidate, at);
			if (!price) continue;
			const bare = parseModelRouteId(modelId)?.modelId ?? modelId;
			if (!BEDROCK_REGIONAL_OPENAI.test(bare)) return price;
			const regional = scaledTokenPrices(price, BEDROCK_REGIONAL_PREMIUM);
			return price.longContext
				? {
						...regional,
						longContext: scaledTokenPrices(
							price.longContext,
							BEDROCK_REGIONAL_PREMIUM,
						),
					}
				: regional;
		}
	return null;
}

/**
 * The bare model id for a route id (`api/<connection>/<model>`), a `codex:` id
 * or a plain id. Claude's direct and Bedrock ids (`claude-opus-5-5`,
 * `anthropic.claude-opus-5-5`, `us.anthropic.claude-opus-5-5-v1:0`) name the
 * same model as the catalog's `claude-opus-5.5`, so they share its price.
 */
export function pricedModelId(routeOrModelId: string) {
	const route = parseModelRouteId(routeOrModelId);
	const id = (route?.modelId ?? routeOrModelId.replace(/^codex:/, ""))
		.replace(/:free$/, "")
		// Bedrock's Claude ids and inference profiles (`global.anthropic.claude-haiku-5-5`).
		.replace(/^(?:[a-z]{2,6}(?:-[a-z]+)?\.)?anthropic\.(?=claude-)/, "")
		// Bedrock's OpenAI ids and inference profiles (`global.openai.gpt-6.1-sol`).
		.replace(/^(?:[a-z]{2,6}(?:-[a-z]+)?\.)?openai\.(?=gpt-)/, "");
	const claude = /^(claude-[a-z]+)-(\d+)-(\d{1,2})(?:-v\d+(?::\d+)?)?$/.exec(
		id,
	);
	return claude ? `${claude[1]}-${claude[2]}.${claude[3]}` : id;
}

/**
 * How a route is billed: per token (with a known or unknown price) or by the
 * user's plan. A plan-billed route still carries the model's list price, so
 * its spend can be shown as a labelled list-price estimate (what the same
 * tokens would cost on the API), never as a charge.
 */
export type ModelBilling =
	| { readonly kind: "plan"; readonly price: ModelPrice | null }
	| { readonly kind: "tokens"; readonly price: ModelPrice | null };

export function modelBilling(input: {
	readonly harness: "codex" | "api";
	readonly modelId: string | null;
}): ModelBilling {
	if (input.harness === "codex")
		return {
			kind: "plan",
			price: input.modelId ? modelPrice(input.modelId) : null,
		};
	if (!input.modelId) return { kind: "tokens", price: null };
	if (/:free$/.test(input.modelId))
		return { kind: "tokens", price: { input: 0, output: 0 } };
	return { kind: "tokens", price: modelPrice(input.modelId) };
}

/** The billing of a session's model (its harness and listed model id). */
export function sessionBilling(session: {
	readonly harness: string;
	readonly listedModelId: string | null;
}) {
	return modelBilling({
		harness: session.harness === "codex" ? "codex" : "api",
		modelId: session.listedModelId,
	});
}

/** The input tokens above which a model's long-context tier applies (per request), if any. */
export function longContextThreshold(modelId: string | null | undefined) {
	return modelId
		? (modelPrice(modelId)?.longContext?.aboveInputTokens ?? null)
		: null;
}

type TokenCounts = Pick<
	ApiTokenUsage,
	| "inputTokens"
	| "outputTokens"
	| "uncachedInputTokens"
	| "cacheReadTokens"
	| "cacheWriteTokens"
>;

function tokensCost(usage: TokenCounts, price: TokenPrices) {
	if (usage.inputTokens === null || usage.outputTokens === null) return null;
	const cacheRead = usage.cacheReadTokens ?? 0;
	const cacheWrite = usage.cacheWriteTokens ?? 0;
	const uncached =
		usage.uncachedInputTokens ??
		Math.max(0, usage.inputTokens - cacheRead - cacheWrite);
	return (
		(uncached * price.input +
			cacheRead * (price.cacheRead ?? price.input) +
			cacheWrite * (price.cacheWrite ?? price.input) +
			usage.outputTokens * price.output) /
		1_000_000
	);
}

function minus(total: TokenCounts, part: LongContextUsage): TokenCounts {
	const sub = (a: number | null, b: number | null) =>
		a === null ? null : Math.max(0, a - (b ?? 0));
	return {
		inputTokens: sub(total.inputTokens, part.inputTokens),
		outputTokens: sub(total.outputTokens, part.outputTokens),
		uncachedInputTokens: sub(
			total.uncachedInputTokens,
			part.uncachedInputTokens,
		),
		cacheReadTokens: sub(total.cacheReadTokens, part.cacheReadTokens),
		cacheWriteTokens: sub(total.cacheWriteTokens, part.cacheWriteTokens),
	};
}

/**
 * Dollars for one usage record: the provider's reported cost when it gave
 * one, else list price × tokens, null when neither is known. For a
 * plan-billed route this is the list-price estimate (callers label it: the
 * user is not charged per token). Requests recorded above the model's
 * long-context threshold are priced at its long-context tier; usage recorded
 * without that split is priced at the base tier.
 */
export function usageCostUsd(
	usage: ApiTokenUsage | null | undefined,
	billing: ModelBilling,
): number | null {
	if (!usage) return 0;
	if (billing.kind === "tokens" && typeof usage.costUsd === "number")
		return usage.costUsd;
	const { price } = billing;
	if (!price) return null;
	const long = usage.longContext;
	if (
		price.longContext &&
		long &&
		long.aboveInputTokens === price.longContext.aboveInputTokens
	) {
		const base = tokensCost(minus(usage, long), price);
		const tier = tokensCost(long, price.longContext);
		return base === null || tier === null ? null : base + tier;
	}
	return tokensCost(usage, price);
}

/**
 * What the same tokens would cost on OpenAI's own API: the list price (no Bedrock geographic
 * premium) and no cache-write charge (OpenAI bills uncached input at the
 * input price). Web search is
 * not included. Null for a model that is not OpenAI's or has no price.
 */
export function openaiDirectCostUsd(
	usage: ApiTokenUsage | null | undefined,
	modelId: string,
): number | null {
	if (!/^(?:[a-z]{2,6}(?:-[a-z]+)?\.)?(?:openai\.)?gpt-/.test(modelId))
		return null;
	const price = modelPrice(pricedModelId(modelId));
	if (!price) return null;
	if (!usage) return 0;
	const uncachedOnly = <T extends TokenCounts>(counts: T): T => ({
		...counts,
		uncachedInputTokens:
			(counts.uncachedInputTokens ??
				Math.max(
					0,
					(counts.inputTokens ?? 0) -
						(counts.cacheReadTokens ?? 0) -
						(counts.cacheWriteTokens ?? 0),
				)) + (counts.cacheWriteTokens ?? 0),
		cacheWriteTokens: 0,
	});
	return usageCostUsd(
		{
			...uncachedOnly(usage),
			costUsd: undefined,
			...(usage.longContext
				? { longContext: uncachedOnly(usage.longContext) }
				: {}),
		},
		{ kind: "tokens", price },
	);
}

/**
 * Dollars per token for a typical agent turn's mix (mostly cached input):
 * 15% uncached input, 80% cache reads, 5% output. Used only to compare two
 * models' prices (budget weights), never to bill.
 */
export function referenceTokenPrice(price: TokenPrices) {
	return (
		(0.15 * price.input +
			0.8 * (price.cacheRead ?? price.input) +
			0.05 * price.output) /
		1_000_000
	);
}
