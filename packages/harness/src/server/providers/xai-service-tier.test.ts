import { describe, expect, it, vi } from "vitest";
import { servedTierWatch, xaiServiceTierFetch } from "./xai-service-tier";

const encoder = new TextEncoder();

function streamOf(chunks: readonly string[]) {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
}

async function watched(chunks: readonly string[]) {
	let served: string | null | undefined;
	const text = await new Response(
		streamOf(chunks).pipeThrough(
			servedTierWatch((tier) => {
				served = tier;
			}),
		),
	).text();
	return { text, served };
}

describe("xAI service tier", () => {
	it("asks for the tier on each model request and keeps the rest of the body", async () => {
		const upstream = vi.fn(
			async (_url: RequestInfo | URL, _init?: RequestInit) =>
				new Response('{"service_tier":"priority"}'),
		);
		const log = vi.fn();
		const call = xaiServiceTierFetch(
			upstream as unknown as typeof fetch,
			"priority",
			log,
		);
		const response = await call("https://api.x.ai/v1/responses", {
			method: "POST",
			body: JSON.stringify({ model: "grok-4.7", input: "hi", stream: true }),
		});
		expect(await response.text()).toBe('{"service_tier":"priority"}');
		expect(JSON.parse(upstream.mock.calls[0]?.[1]?.body as string)).toEqual({
			model: "grok-4.7",
			input: "hi",
			stream: true,
			service_tier: "priority",
		});
		expect(log).not.toHaveBeenCalled();
	});

	it("logs a request served at the default tier, without the body", async () => {
		const log = vi.fn();
		const call = xaiServiceTierFetch(
			async () =>
				new Response(
					'event: response.completed\ndata: {"response":{"service_tier":"default","output":"secret-text"}}\n\n',
				),
			"priority",
			log,
		);
		await (
			await call("https://api.x.ai/v1/responses", {
				method: "POST",
				body: '{"model":"grok-4.6","input":"secret-prompt"}',
			})
		).text();
		expect(log).toHaveBeenCalledWith(
			"xAI served a fast request at another tier.",
			{ model: "grok-4.6", requested: "priority", served: "default" },
		);
		expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret/);
	});

	it("leaves requests without a model, and failed responses, alone", async () => {
		const upstream = vi.fn(async () => new Response("no", { status: 429 }));
		const log = vi.fn();
		const call = xaiServiceTierFetch(
			upstream as unknown as typeof fetch,
			"priority",
			log,
		);
		await call("https://api.x.ai/v1/models", { method: "GET" });
		expect(
			(
				await call("https://api.x.ai/v1/responses", {
					method: "POST",
					body: '{"model":"grok-4.7"}',
				})
			).status,
		).toBe(429);
		expect(upstream.mock.calls[0]).toEqual([
			"https://api.x.ai/v1/models",
			{ method: "GET" },
		]);
		expect(log).not.toHaveBeenCalled();
	});

	it("reads the last tier in a stream, even split across chunks", async () => {
		const result = await watched([
			'data: {"response":{"service_tier":"pri',
			'ority"}}\n\ndata: {"delta":"he said \\"service_tier\\":\\"default\\""}\n\n',
			'data: {"response":{"service_tier"',
			':"priority"}}\n\n',
		]);
		expect(result.served).toBe("priority");
		expect(result.text).toContain('\\"service_tier\\":\\"default\\"');
		expect(
			(
				await watched([
					'{"service_tier":"priority"}',
					'{"service_tier":"default"}',
				])
			).served,
		).toBe("default");
		expect((await watched(["data: {}\n\n"])).served).toBeNull();
	});
});
