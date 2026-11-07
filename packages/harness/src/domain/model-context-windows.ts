import { pricedModelId } from "./model-pricing";

type KnownModelLimits = {
	/** Input plus output tokens the maker's own API accepts. */
	readonly contextWindow: number;
	/** Whether the model reads images. */
	readonly imageInput: boolean;
};

/**
 * Context windows of the models ytimesy routes (api-model-list.ts and the
 * unattended routes), keyed by the bare model id. A catalog outage must not
 * shrink a run's budget to the unknown-window guess, and a run must not
 * depend on a third-party catalog being reachable, so these are used before
 * the public catalog and whenever an owner-authenticated lookup fails.
 * Values as openrouter.ai/api/v1/models listed them on 2026-10-28
 * (context_length and architecture.input_modalities). A route that serves a
 * model with a smaller window (Bedrock's Claude, 200K) states it explicitly.
 */
const KNOWN_MODEL_LIMITS: Readonly<Record<string, KnownModelLimits>> = {
	"gpt-6.1-sol": { contextWindow: 1_050_000, imageInput: true },
	"gpt-6-sol": { contextWindow: 1_050_000, imageInput: true },
	"gpt-6-luna": { contextWindow: 1_050_000, imageInput: true },
	"gpt-6-astra": { contextWindow: 1_050_000, imageInput: true },
	"gpt-5.6-sol": { contextWindow: 1_050_000, imageInput: true },
	"gpt-5.6-luna": { contextWindow: 1_050_000, imageInput: true },
	"claude-opus-5.5": { contextWindow: 1_000_000, imageInput: true },
	"claude-sonnet-5.5": { contextWindow: 1_000_000, imageInput: true },
	"claude-haiku-5.5": { contextWindow: 1_000_000, imageInput: true },
	"claude-fable-5.1": { contextWindow: 1_000_000, imageInput: true },
	"gemini-4-argon": { contextWindow: 1_048_576, imageInput: true },
	"gemini-3.8-flash": { contextWindow: 1_048_576, imageInput: true },
	"gemini-3.7-flash": { contextWindow: 1_048_576, imageInput: true },
	"grok-4.7": { contextWindow: 500_000, imageInput: true },
	"grok-4.6": { contextWindow: 500_000, imageInput: true },
	"muse-wonder": { contextWindow: 1_048_576, imageInput: true },
	"muse-spark-1.3": { contextWindow: 1_048_576, imageInput: true },
	"deepseek-v4.1-flash": { contextWindow: 1_048_576, imageInput: true },
	"deepseek-v4-pro-0813": { contextWindow: 1_048_576, imageInput: false },
	"glm-5.3": { contextWindow: 1_048_576, imageInput: false },
	"kimi-k3": { contextWindow: 1_048_576, imageInput: true },
	"qwen3.8-max-prime": { contextWindow: 1_000_000, imageInput: true },
};

/**
 * The checked-in limits of a routed model by any of its ids: the maker's
 * (gpt-6-astra, claude-opus-5-5), OpenRouter's (openai/gpt-6-astra) or
 * Bedrock's (global.openai.gpt-6-astra). Undefined for anything else; an
 * unlisted variant (a -pro, a custom name) is never guessed from its family.
 */
export function knownModelLimits(
	modelId: string,
): KnownModelLimits | undefined {
	const bare = pricedModelId(modelId)
		.replace(/:[\w-]+$/, "")
		.replace(/^[\w-]+\//, "");
	return Object.hasOwn(KNOWN_MODEL_LIMITS, bare)
		? KNOWN_MODEL_LIMITS[bare]
		: undefined;
}
