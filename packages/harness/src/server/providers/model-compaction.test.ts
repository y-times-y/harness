import { simulateReadableStream, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import {
	nativeModelCompactor,
	responsesEndpointCompactor,
} from "./model-compaction";

const usage = {
	inputTokens: { total: 50, noCache: 50, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 10, text: 10, reasoning: 0 },
};
const finish = {
	type: "finish" as const,
	usage,
	finishReason: { unified: "stop" as const, raw: "completed" },
};

it("preserves a compaction provider failure as its cause without exposing it as chat text", async () => {
	const failure = new Error("fixture provider failure");
	const model = new MockLanguageModelV4({
		doStream: async () => ({
			stream: simulateReadableStream({
				chunks: [{ type: "error" as const, error: failure }],
				initialDelayInMs: null,
				chunkDelayInMs: null,
			}),
		}),
	});
	await expect(
		nativeModelCompactor(model, "openai", () => ({}))({
			messages: [{ role: "user", content: "Keep the requirement" }],
			instructions: "Stable instructions",
			tools: {},
			signal: new AbortController().signal,
		}),
	).rejects.toMatchObject({
		message: "Native context compaction failed; history was preserved.",
		cause: failure,
	});
});

it("uses SDK wire conversion for xAI's explicit compact endpoint and replays its encrypted result", async () => {
	const fetch = vi.fn(
		async (_url: Parameters<typeof globalThis.fetch>[0], _init?: RequestInit) =>
			Response.json({
				output: [
					{
						type: "compaction",
						id: "cmp-xai",
						encrypted_content: "opaque-xai",
					},
				],
				usage: { input_tokens: 50, output_tokens: 10, total_tokens: 60 },
			}),
	);
	const compact = responsesEndpointCompactor({
		baseUrl: "https://api.x.ai/v1",
		apiKey: "fixture",
		modelId: "grok-4.7",
		fetch,
	});
	const result = await compact({
		messages: [{ role: "user", content: "Keep this" }],
		instructions: "Stable instructions",
		tools: {},
		signal: new AbortController().signal,
	});
	expect(fetch.mock.calls[0][0]).toBe("https://api.x.ai/v1/responses/compact");
	const body = JSON.parse(String(fetch.mock.calls[0][1]?.body));
	expect(body.input).toEqual(
		expect.arrayContaining([expect.objectContaining({ role: "user" })]),
	);
	expect(JSON.stringify(body)).toContain("Stable instructions");
	expect(JSON.stringify(result.messages)).toContain("opaque-xai");
	expect(result.usage.inputTokens).toBe(50);
});

it("retains OpenAI's canonical user items in their returned order, including duplicate user text", async () => {
	const fetch = vi.fn(
		async (
			_url: Parameters<typeof globalThis.fetch>[0],
			init?: RequestInit,
		) => {
			const body = JSON.parse(String(init?.body));
			return Response.json({
				output: [
					...body.input
						.filter((item: { role?: string }) => item.role === "user")
						.map((item: object) => ({ ...item, type: "message" })),
					{ type: "compaction", id: "cmp-openai", encrypted_content: "opaque" },
				],
				usage: { input_tokens: 50, output_tokens: 10, total_tokens: 60 },
			});
		},
	);
	const users = [
		{ role: "user" as const, content: "Again" },
		{ role: "user" as const, content: "Again" },
	];
	const result = await responsesEndpointCompactor({
		baseUrl: "https://api.openai.com/v1",
		apiKey: "fixture",
		modelId: "gpt-5.4",
		fetch,
	})({
		messages: users,
		instructions: "Stable",
		tools: {},
		signal: new AbortController().signal,
	});
	expect(result.messages.slice(0, 2)).toEqual(users);
	expect(result.messages[2]).toMatchObject({
		role: "assistant",
		content: [{ type: "custom" }],
	});
	expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).instructions).toBe(
		"Stable",
	);
});

it("keeps encrypted compaction state replayable across JSON checkpoints without exposing it as chat text", async () => {
	const model = new MockLanguageModelV4({
		doStream: async () => ({
			stream: simulateReadableStream({
				chunks: [
					{
						type: "custom" as const,
						kind: "openai.compaction",
						providerMetadata: {
							openai: {
								type: "compaction",
								itemId: "cmp-fixture",
								encryptedContent: "opaque-fixture",
							},
						},
					},
					finish,
				],
				initialDelayInMs: null,
				chunkDelayInMs: null,
			}),
		}),
	});
	const execute = vi.fn();
	const compact = nativeModelCompactor(model, "openai", (instructions) => ({
		providerOptions: {
			openai: { instructions, store: false, reasoningEffort: "low" },
		},
	}));
	const result = await compact({
		messages: [{ role: "user", content: "Keep this requirement" }],
		instructions: "Stable project context",
		tools: { inspect: tool({ inputSchema: z.object({}), execute }) },
		signal: new AbortController().signal,
	});
	expect(model.doStreamCalls[0].providerOptions?.openai).toMatchObject({
		compactionTrigger: true,
		store: false,
		instructions: "Stable project context",
	});
	expect(model.doStreamCalls[0].toolChoice).toEqual({ type: "none" });
	expect(JSON.parse(JSON.stringify(result.messages))).toEqual(result.messages);
	expect(JSON.stringify(result.messages)).toContain("opaque-fixture");
	expect(result.messages[0]).toMatchObject({
		role: "assistant",
		content: [
			{
				type: "custom",
				kind: "openai.compaction",
				providerOptions: { openai: { encryptedContent: "opaque-fixture" } },
			},
		],
	});
	expect(execute).not.toHaveBeenCalled();
	expect(result.usage.inputTokens).toBe(50);
});

it("preserves signed Anthropic compaction blocks using the SDK's native request option", async () => {
	const model = new MockLanguageModelV4({
		doStream: async () => ({
			stream: simulateReadableStream({
				chunks: [
					{
						type: "text-start" as const,
						id: "compact",
						providerMetadata: {
							anthropic: { type: "compaction", signature: "signed-fixture" },
						},
					},
					{
						type: "text-delta" as const,
						id: "compact",
						delta: "Keep the pending task and test failures.",
					},
					{ type: "text-end" as const, id: "compact" },
					{
						...finish,
						finishReason: { unified: "stop" as const, raw: "compaction" },
					},
				],
				initialDelayInMs: null,
				chunkDelayInMs: null,
			}),
		}),
	});
	const result = await nativeModelCompactor(model, "anthropic", (system) => ({
		system,
	}))({
		messages: [{ role: "user", content: "Task" }],
		instructions: "Stable instructions",
		tools: {},
		signal: new AbortController().signal,
	});
	expect(model.doStreamCalls[0].providerOptions?.anthropic).toMatchObject({
		compaction: { type: "summarize" },
	});
	expect(JSON.stringify(result.messages)).toContain("signed-fixture");
});

it("rejects plain text or missing encrypted state instead of pretending native compaction succeeded", async () => {
	const model = new MockLanguageModelV4({
		doStream: async () => ({
			stream: simulateReadableStream({
				chunks: [finish],
				initialDelayInMs: null,
				chunkDelayInMs: null,
			}),
		}),
	});
	await expect(
		nativeModelCompactor(model, "openai", (system) => ({ system }))({
			messages: [{ role: "user", content: "Task" }],
			instructions: "Instructions",
			tools: {},
			signal: new AbortController().signal,
		}),
	).rejects.toThrow("no usable checkpoint");
});
