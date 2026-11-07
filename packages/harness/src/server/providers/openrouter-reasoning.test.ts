import { simulateReadableStream, streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { expect, it } from "vitest";
import { withOpenRouterReasoning } from "./openrouter-reasoning";

it("checkpoints encrypted-only streaming state without emitting ciphertext or fake visible reasoning", async () => {
	const details = [
		{
			type: "reasoning.encrypted",
			data: "opaque-only",
			id: "rs-one",
			format: "openai-responses-v1",
		},
	];
	const model = withOpenRouterReasoning(
		new MockLanguageModelV4({
			doStream: async () => ({
				stream: simulateReadableStream({
					chunks: [
						{ type: "text-start", id: "answer" },
						{ type: "text-delta", id: "answer", delta: "Done" },
						{ type: "text-end", id: "answer" },
						{
							type: "finish",
							finishReason: { unified: "stop", raw: "stop" },
							usage: {
								inputTokens: {
									total: 10,
									noCache: 10,
									cacheRead: 0,
									cacheWrite: 0,
								},
								outputTokens: { total: 5, text: 5, reasoning: 0 },
							},
							providerMetadata: { openrouter: { reasoning_details: details } },
						},
					],
					initialDelayInMs: null,
					chunkDelayInMs: null,
				}),
			}),
		}),
	);
	const result = streamText({ model, prompt: "Task" });
	let visible = "";
	for await (const part of result.fullStream)
		if (part.type === "text-delta" || part.type === "reasoning-delta")
			visible += part.text;
	expect(visible).toBe("Done");
	expect(JSON.stringify((await result.response).messages)).toContain(
		"opaque-only",
	);
});
