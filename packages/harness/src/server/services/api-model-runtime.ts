import type { LanguageModel } from "ai";
import type { ApiModelSpeedId } from "../../domain/api-model-list";
import { defaultMaxOutputTokens } from "../../domain/api-output-limit";
import {
	apiContextWindowOption,
	type ModelProvider,
} from "../../domain/model-connection";
import { connectedLanguageModel } from "../providers/api-model";
import { apiPromptCacheSettings } from "../providers/api-prompt-cache";
import {
	apiReasoningEffort,
	withReasoningEffort,
} from "../providers/api-reasoning-effort";
import {
	nativeModelCompactor,
	responsesEndpointCompactor,
} from "../providers/model-compaction";
import { readModelContext } from "../providers/model-context";
import type { ModelAgentRuntime } from "./model-agent-loop";

/**
 * The window an API turn budgets against: the reported window, exactly as
 * before the option existed, unless the route's cheaper tier was chosen;
 * then the tier, never above what the provider reports.
 */
export function apiTurnContextWindow(
	input: {
		provider: ModelProvider;
		baseUrl: string;
		modelId: string;
		alternateContext?: boolean;
		subscription?: unknown;
	},
	reported: number | undefined,
): number | undefined {
	if (!input.alternateContext) return reported;
	const option = apiContextWindowOption(input, input.modelId);
	if (!option) return reported;
	return reported ? Math.min(option.alternate, reported) : option.alternate;
}

/**
 * The model runtime of an API route, from the route's endpoint and key: the
 * request settings, prompt-cache routing, reasoning effort, context window
 * and native compaction every API-harness turn uses. prepareApiModel calls
 * it for a stored connection; unattended runs call it
 * with a key file, so both run the same runtime.
 */
export async function apiModelRuntime(
	input: {
		provider: ModelProvider;
		baseUrl: string;
		apiKey: string;
		modelId: string;
		speed?: ApiModelSpeedId;
		/** Local runner: any OpenRouter model, without the product's model list. */
		anyOpenRouterModel?: boolean;
		/**
		 * On a route with a long-context price tier (apiContextWindowOption),
		 * true budgets within that tier; otherwise the full window, as always.
		 */
		alternateContext?: boolean;
		/** Set on a plan sign-in (the Grok plan), which has no such tier. */
		subscription?: unknown;
		userId: string;
		connectionId: string;
		cacheScopeId: string;
		/** Caches the model's catalog limits; a stored connection adds its revision. */
		contextCacheKey: string;
		/** The connection's own catalog row, when it lists one. */
		contextWindow?: number;
		reasoning?: string;
		maxOutputTokens?: number;
		fetch: typeof globalThis.fetch;
		/**
		 * Wraps the model before anything uses it (a run's spending
		 * guard), so native compaction's requests go through the wrapper too.
		 */
		wrapModel?: (model: LanguageModel) => LanguageModel;
	},
	onStage: (stage: string) => void = () => {},
): Promise<ModelAgentRuntime> {
	onStage("model");
	const connected = connectedLanguageModel(input, input.fetch);
	const model = input.wrapModel ? input.wrapModel(connected) : connected;
	const cacheSettings = apiPromptCacheSettings({
		provider: input.provider,
		baseUrl: input.baseUrl,
		userId: input.userId,
		connectionId: input.connectionId,
		scopeId: input.cacheScopeId,
	});
	const origin = new URL(input.baseUrl).origin;
	const responsesRoute =
		input.provider === "openai" ||
		(input.provider === "compatible" &&
			["https://api.x.ai", "https://api.meta.ai"].includes(origin));
	const boundPrefix =
		input.provider === "anthropic" ||
		input.provider === "google" ||
		(input.provider === "openrouter" &&
			/^(anthropic|google)\//.test(input.modelId));
	onStage("context");
	const context = await readModelContext(
		{
			provider: input.provider,
			baseUrl: input.baseUrl,
			apiKey: input.apiKey,
			modelId: input.modelId,
			contextWindow: input.contextWindow,
			cacheKey: input.contextCacheKey,
		},
		input.fetch,
	);
	const effort = apiReasoningEffort(input.reasoning);
	const baseRequestSettings = (instructions: string) =>
		responsesRoute
			? {
					...cacheSettings,
					providerOptions: {
						...cacheSettings.providerOptions,
						openai: {
							...cacheSettings.providerOptions?.openai,
							instructions,
							store: false,
							include: ["reasoning.encrypted_content"],
						},
					},
				}
			: {
					...cacheSettings,
					system: instructions,
					...(context.nativeCompaction === "anthropic" &&
					origin === "https://api.anthropic.com"
						? {
								providerOptions: {
									...cacheSettings.providerOptions,
									anthropic: {
										...cacheSettings.providerOptions?.anthropic,
										thinking: {
											// The API rejects a thinking object without a type.
											type: "adaptive",
											blockBinding: { prefixMismatchBehavior: "error" },
										},
									},
								},
							}
						: {}),
				};
	const requestSettings = (instructions: string) =>
		withReasoningEffort(
			baseRequestSettings(instructions),
			input.provider,
			effort,
		);
	onStage("inference");
	return {
		model,
		cacheSettings,
		maxOutputTokens:
			input.maxOutputTokens ??
			defaultMaxOutputTokens(input.provider, input.modelId),
		contextWindow: apiTurnContextWindow(input, context.contextWindow),
		imageInput: context.imageInput,
		fallbackContextPolicy: boundPrefix ? "bound-prefix" : "whole-turns",
		backgroundCompaction: input.provider === "openai",
		requestSettings,
		compact:
			context.nativeCompaction === "xai" ||
			context.nativeCompaction === "openai-endpoint"
				? responsesEndpointCompactor(input)
				: context.nativeCompaction
					? nativeModelCompactor(
							model,
							context.nativeCompaction,
							requestSettings,
						)
					: undefined,
	};
}
