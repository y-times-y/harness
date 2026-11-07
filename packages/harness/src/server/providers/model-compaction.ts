import { createOpenAI } from "@ai-sdk/openai";
import {
	generateText,
	type LanguageModel,
	type ModelMessage,
	streamText,
	type ToolSet,
} from "ai";
import type { ModelAgentRuntime } from "../services/model-agent-loop";

export type NativeCompactionInput = {
	messages: ModelMessage[];
	instructions: string;
	tools: ToolSet;
	signal: AbortSignal;
};

/**
 * Reuse the SDK's Responses encoding and decoding; only the documented
 * endpoint (POST /responses/compact) differs. `wrapModel` (an evaluation's
 * spending guard) sees each compaction request as one model request.
 */
export function responsesEndpointCompactor(input: {
	baseUrl: string;
	apiKey: string;
	modelId: string;
	fetch: typeof globalThis.fetch;
	wrapModel?: (model: LanguageModel) => LanguageModel;
}) {
	return async (context: NativeCompactionInput) => {
		context.signal.throwIfAborted();
		let retainedOrder: Array<ModelMessage | string> = [];
		const openaiEndpoint =
			new URL(input.baseUrl).origin === "https://api.openai.com";
		const endpoint = createOpenAI({
			apiKey: input.apiKey,
			baseURL: input.baseUrl,
			fetch: async (url, init) => {
				if (
					typeof init?.body !== "string" ||
					!String(url).endsWith("/responses")
				)
					throw new Error("Invalid native compaction transport request.");
				const body = JSON.parse(init.body);
				const response = await input.fetch(
					`${input.baseUrl}/responses/compact`,
					{
						...init,
						body: JSON.stringify({
							model: body.model,
							input: body.input,
							...(body.instructions ? { instructions: body.instructions } : {}),
						}),
					},
				);
				if (!response.ok) return response;
				const result = await response.json();
				if (
					!result ||
					typeof result !== "object" ||
					!("output" in result) ||
					!Array.isArray(result.output)
				)
					throw new Error("Invalid native compaction output.");
				const originalUsers = context.messages.filter(
					(message) => message.role === "user",
				);
				const wireUsers = body.input.filter(
					(item: { role?: string }) => item.role === "user",
				);
				let userIndex = 0;
				retainedOrder = result.output.map(
					(item: {
						type: string;
						role?: string;
						content?: unknown;
						id?: string;
					}) => {
						if (item.type === "compaction" && typeof item.id === "string")
							return item.id;
						if (item.type === "message" && item.role === "user") {
							while (userIndex < wireUsers.length) {
								const index = userIndex++;
								if (
									JSON.stringify(wireUsers[index].content) ===
										JSON.stringify(item.content) &&
									originalUsers[index]
								)
									return originalUsers[index];
							}
						}
						throw new Error(
							"Unsupported native compaction item; original history was preserved.",
						);
					},
				);
				// The SDK decodes assistant artifacts, not retained user input items.
				return Response.json({
					...result,
					output: result.output.filter(
						(item: { type: string }) => item.type === "compaction",
					),
				});
			},
		}).responses(input.modelId);
		const model = input.wrapModel ? input.wrapModel(endpoint) : endpoint;
		const result = await generateText({
			model,
			...(openaiEndpoint ? {} : { system: context.instructions }),
			messages: context.messages,
			providerOptions: {
				openai: {
					store: false,
					include: ["reasoning.encrypted_content"],
					...(openaiEndpoint ? { instructions: context.instructions } : {}),
				},
			},
			maxRetries: 0,
			abortSignal: context.signal,
		});
		const messages = result.response.messages;
		if (!messages.length || !messages.some(isNativeCompactionMessage))
			throw new Error(
				"Native compaction returned no usable checkpoint; history was preserved.",
			);
		const artifacts = messages.flatMap((message) =>
			message.role === "assistant" && Array.isArray(message.content)
				? message.content.filter((part) => part.type === "custom")
				: [],
		);
		const canonical = retainedOrder.map((item): ModelMessage => {
			if (typeof item !== "string") return item;
			const part = artifacts.find(
				(artifact) => artifact.providerOptions?.openai?.itemId === item,
			);
			if (!part)
				throw new Error(
					"Native compaction lost an output item; original history was preserved.",
				);
			return { role: "assistant", content: [part] };
		});
		return { messages: canonical, usage: result.totalUsage };
	};
}

function isNativeCompactionMessage(message: ModelMessage): boolean {
	return (
		message.role === "assistant" &&
		Array.isArray(message.content) &&
		message.content.some(
			(part) =>
				(part.type === "custom" &&
					part.kind === "openai.compaction" &&
					typeof part.providerOptions?.openai?.encryptedContent === "string" &&
					!!part.providerOptions.openai.encryptedContent &&
					typeof part.providerOptions.openai.itemId === "string") ||
				(part.type === "text" &&
					!!part.text &&
					part.providerOptions?.anthropic?.type === "compaction" &&
					typeof part.providerOptions.anthropic.signature === "string" &&
					!!part.providerOptions.anthropic.signature),
		)
	);
}

/** SDK-owned replay format keeps encrypted OpenAI state and signed Claude blocks intact. */
export function nativeModelCompactor(
	model: LanguageModel,
	provider: "openai" | "anthropic",
	requestSettings: NonNullable<ModelAgentRuntime["requestSettings"]>,
) {
	return async (input: NativeCompactionInput) => {
		input.signal.throwIfAborted();
		const settings = requestSettings(input.instructions);
		const declarations = Object.fromEntries(
			Object.entries(input.tools).map(([name, definition]) => {
				const { execute: _execute, ...declaration } = definition;
				return [name, declaration];
			}),
		);
		const result = streamText({
			model,
			...settings,
			messages: input.messages,
			tools: declarations,
			toolChoice: "none",
			providerOptions: {
				...settings.providerOptions,
				[provider]: {
					...settings.providerOptions?.[provider],
					...(provider === "openai"
						? { store: false, compactionTrigger: true }
						: { compaction: { type: "summarize" } }),
				},
			},
			maxOutputTokens: provider === "anthropic" ? 4096 : undefined,
			maxRetries: 0,
			streamRetries: 0,
			abortSignal: input.signal,
			onError: () => {},
		});
		for await (const event of result.fullStream) {
			if (event.type === "error" || event.type === "abort")
				throw new Error(
					"Native context compaction failed; history was preserved.",
					{ cause: event.type === "error" ? event.error : input.signal.reason },
				);
		}
		const messages = (await result.response).messages;
		if (
			provider === "anthropic" &&
			(await result.rawFinishReason) !== "compaction"
		)
			throw new Error(
				"Native compaction did not finish; original history was preserved.",
			);
		if (
			!messages.length ||
			!messages.some(isNativeCompactionMessage) ||
			messages.some(
				(message) =>
					message.role === "assistant" &&
					Array.isArray(message.content) &&
					message.content.some((part) => part.type === "tool-call"),
			)
		)
			throw new Error(
				"Native compaction returned no usable checkpoint; history was preserved.",
			);
		return { messages, usage: await result.totalUsage };
	};
}
