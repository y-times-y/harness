import { type LanguageModelMiddleware, wrapLanguageModel } from "ai";

const replayFormats = new Set([
	"unknown",
	"openai-responses-v1",
	"azure-openai-responses-v1",
	"xai-responses-v1",
	"anthropic-claude-v1",
	"google-gemini-v1",
]);

function assertReplayableDetails(value: unknown) {
	if (!value || typeof value !== "object") return;
	const choices = (
		value as {
			choices?: Array<{
				delta?: { reasoning_details?: unknown[] };
				message?: { reasoning_details?: unknown[] };
			}>;
		}
	).choices;
	for (const choice of choices ?? [])
		for (const detail of choice.delta?.reasoning_details ??
			choice.message?.reasoning_details ??
			[]) {
			if (!detail || typeof detail !== "object") continue;
			const item = detail as { type?: string; format?: string };
			if (
				!item.type ||
				![
					"reasoning.text",
					"reasoning.summary",
					"reasoning.encrypted",
				].includes(item.type) ||
				(item.format && !replayFormats.has(item.format))
			)
				throw new Error(
					"Unsupported OpenRouter reasoning protocol; refusing to silently discard provider state.",
				);
		}
}

export function openRouterReasoningFetch(
	fetch: typeof globalThis.fetch,
): typeof globalThis.fetch {
	return async (url, init) => {
		const response = await fetch(url, init);
		if (
			response.ok &&
			typeof init?.body === "string" &&
			!JSON.parse(init.body).stream
		)
			assertReplayableDetails(await response.clone().json());
		return response;
	};
}

/** The provider returns encrypted-only state at finish; AI SDK checkpoints need a content part. */
const openRouterReasoningMiddleware: LanguageModelMiddleware = {
	specificationVersion: "v4",
	transformParams: async ({ params }) => ({
		...params,
		includeRawChunks: true,
	}),
	wrapGenerate: async ({ doGenerate }) => {
		const result = await doGenerate();
		const details = result.providerMetadata?.openrouter?.reasoning_details;
		return Array.isArray(details) && details.length
			? {
					...result,
					content: [
						{
							type: "reasoning" as const,
							text: "",
							providerMetadata: { openrouter: { reasoning_details: details } },
						},
						...result.content,
					],
				}
			: result;
	},
	wrapStream: async ({ doStream }) => {
		const result = await doStream();
		return {
			...result,
			stream: result.stream.pipeThrough(
				new TransformStream({
					transform(part, controller) {
						if (part.type === "raw") {
							assertReplayableDetails(part.rawValue);
							return;
						}
						if (part.type === "finish") {
							const details =
								part.providerMetadata?.openrouter?.reasoning_details;
							if (Array.isArray(details) && details.length) {
								const id = "openrouter-replay-state";
								controller.enqueue({
									type: "reasoning-start",
									id,
									providerMetadata: {
										openrouter: { reasoning_details: details },
									},
								});
								controller.enqueue({ type: "reasoning-end", id });
							}
						}
						controller.enqueue(part);
					},
				}),
			),
		};
	},
};

export const withOpenRouterReasoning = (
	model: Parameters<typeof wrapLanguageModel>[0]["model"],
) => wrapLanguageModel({ model, middleware: openRouterReasoningMiddleware });
