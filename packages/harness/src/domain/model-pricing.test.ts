import { describe, expect, it } from "vitest";
import { addApiTokenUsage, requestTokenUsage } from "./api-token-usage";
import {
	KNOWN_MODEL_PRICES,
	longContextThreshold,
	modelBilling,
	modelPrice,
	openaiDirectCostUsd,
	pricedModelId,
	referenceTokenPrice,
	usageCostUsd,
} from "./model-pricing";
import {
	BUDGET_WEIGHT_MAX,
	BUDGET_WEIGHT_MIN,
	budgetTokenWeight,
} from "./subagent-usage";

describe("pricedModelId", () => {
	it("maps Claude's direct and Bedrock ids onto the catalog id", () => {
		expect(pricedModelId("claude-opus-5-5")).toBe("claude-opus-5.5");
		expect(pricedModelId("claude-sonnet-5-5")).toBe("claude-sonnet-5.5");
		expect(pricedModelId("anthropic.claude-opus-5-5")).toBe("claude-opus-5.5");
		expect(pricedModelId("us.anthropic.claude-opus-5-5-v1:0")).toBe(
			"claude-opus-5.5",
		);
		expect(pricedModelId("global.anthropic.claude-haiku-5-5")).toBe(
			"claude-haiku-5.5",
		);
	});

	it("leaves other ids as they were", () => {
		expect(pricedModelId("gpt-6.1-sol")).toBe("gpt-6.1-sol");
		expect(pricedModelId("codex:gpt-6.1-sol")).toBe("gpt-6.1-sol");
		expect(pricedModelId("anthropic/claude-opus-5.5")).toBe(
			"anthropic/claude-opus-5.5",
		);
		expect(pricedModelId("google/gemini-3.8-flash:free")).toBe(
			"google/gemini-3.8-flash",
		);
		// A dated snapshot is a different id, never guessed onto a price.
		expect(pricedModelId("claude-sonnet-4-5-20250929")).toBe(
			"claude-sonnet-4-5-20250929",
		);
	});
});

describe("modelBilling", () => {
	it("prices Claude's direct API ids", () => {
		for (const [id, catalog] of [
			["claude-opus-5-5", "anthropic/claude-opus-5.5"],
			["claude-sonnet-5-5", "anthropic/claude-sonnet-5.5"],
			["anthropic.claude-opus-5-5", "anthropic/claude-opus-5.5"],
		] as const)
			expect(modelBilling({ harness: "api", modelId: id })).toEqual({
				kind: "tokens",
				price: KNOWN_MODEL_PRICES[catalog],
			});
	});

	it("gives a dollar cost for a direct Claude usage record", () => {
		const cost = usageCostUsd(
			{
				inputTokens: 1_000_000,
				outputTokens: 100_000,
				uncachedInputTokens: 200_000,
				cacheReadTokens: 700_000,
				cacheWriteTokens: 100_000,
			},
			modelBilling({ harness: "api", modelId: "claude-opus-5-5" }),
		);
		// 0.2M x $4 + 0.7M x $0.20 + 0.1M x $5 + 0.1M x $20
		expect(cost).toBeCloseTo(0.8 + 0.14 + 0.5 + 2, 6);
	});

	it("prices Gemini's direct API id", () => {
		expect(
			modelBilling({ harness: "api", modelId: "gemini-3.8-flash" }).price,
		).toEqual(KNOWN_MODEL_PRICES["google/gemini-3.8-flash"]);
	});

	it("still has no price for an unknown model", () => {
		expect(
			modelBilling({ harness: "api", modelId: "claude-opus-9-9" }).price,
		).toBeNull();
	});
});

const request = (input: number, cached: number, output: number) => ({
	inputTokens: input,
	outputTokens: output,
	uncachedInputTokens: input - cached,
	cacheReadTokens: cached,
	cacheWriteTokens: 0,
});

describe("price table", () => {
	it("finds a price by OpenRouter id, direct id, plan slug or route id", () => {
		const luna = modelPrice("openai/gpt-6-luna");
		expect(luna).toMatchObject({ input: 0.1, cacheRead: 0.01, output: 0.5 });
		expect(modelPrice("gpt-6-luna")).toBe(luna);
		expect(modelPrice("codex:gpt-6-luna")).toBe(luna);
		expect(modelPrice("claude-opus-5-5")).toMatchObject({ input: 4 });
		expect(modelPrice("gemini-3.8-flash")).toMatchObject({ input: 0.75 });
		expect(
			modelPrice(
				`api/${"5".repeat(8)}-5555-4555-8555-${"5".repeat(12)}/${encodeURIComponent("moonshotai/kimi-k3")}`,
			),
		).toMatchObject({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 });
		expect(modelPrice("acme/unknown")).toBeNull();
	});

	it("applies announced price changes from their date", () => {
		const before = Date.parse("2026-11-30T12:00:00Z");
		const after = Date.parse("2026-12-01T00:00:00Z");
		expect(modelPrice("google/gemini-4-argon", before)?.input).toBe(2);
		expect(modelPrice("google/gemini-4-argon", after)?.input).toBe(4);
		expect(
			modelPrice("google/gemini-3.8-flash", Date.parse("2027-01-02"))?.output,
		).toBe(7.5);
	});

	it("has the long-context thresholds the providers list", () => {
		expect(longContextThreshold("gpt-6.1-sol")).toBe(272_000);
		expect(longContextThreshold("anthropic/claude-haiku-5.5")).toBe(100_000);
		expect(longContextThreshold("anthropic/claude-opus-5.5")).toBeNull();
		expect(longContextThreshold(null)).toBeNull();
	});
});

describe("per-request tiered pricing", () => {
	const sol = modelBilling({ harness: "api", modelId: "openai/gpt-6.1-sol" });

	it("prices requests above 272K at Sol's long-context tier", () => {
		const threshold = longContextThreshold("openai/gpt-6.1-sol");
		const small = requestTokenUsage(request(100_000, 80_000, 1_000), threshold);
		const large = requestTokenUsage(
			request(300_000, 250_000, 2_000),
			threshold,
		);
		expect(small.longContext).toBeUndefined();
		expect(large.longContext).toMatchObject({
			requests: 1,
			inputTokens: 300_000,
		});
		const turn = addApiTokenUsage(small, large);
		expect(turn.requests).toBe(2);
		expect(turn.longContext).toMatchObject({
			aboveInputTokens: 272_000,
			requests: 1,
			cacheReadTokens: 250_000,
		});
		// Base: 20K × $2 + 80K × $0.10 + 1K × $10; long: 50K × $4 + 250K × $0.20 + 2K × $15.
		const base = (20_000 * 2 + 80_000 * 0.1 + 1_000 * 10) / 1e6;
		const long = (50_000 * 4 + 250_000 * 0.2 + 2_000 * 15) / 1e6;
		expect(usageCostUsd(turn, sol)).toBeCloseTo(base + long, 10);
		// Without the per-request split everything is priced at the base tier.
		const { longContext: _drop, ...flat } = turn;
		expect(usageCostUsd(flat, sol)).toBeLessThan(base + long);
	});

	it("ignores a split recorded for another threshold", () => {
		const turn = requestTokenUsage(request(150_000, 0, 0), 100_000);
		const opus = modelBilling({
			harness: "api",
			modelId: "anthropic/claude-opus-5.5",
		});
		expect(usageCostUsd(turn, opus)).toBeCloseTo(0.6);
	});

	it("keeps request counts and splits through accumulation", () => {
		let total = null as ReturnType<typeof addApiTokenUsage> | null;
		for (let index = 0; index < 3; index++)
			total = addApiTokenUsage(
				total,
				requestTokenUsage(request(400_000, 0, 10), 272_000),
			);
		expect(total?.requests).toBe(3);
		expect(total?.longContext?.requests).toBe(3);
		expect(total?.longContext?.inputTokens).toBe(1_200_000);
	});
});

describe("budget weights", () => {
	it("weights a child's tokens by its price relative to the builder's, clamped", () => {
		expect(budgetTokenWeight("gpt-6.1-sol", "gpt-6.1-sol")).toBe(1);
		expect(budgetTokenWeight("gpt-6-luna", "anthropic/claude-opus-5.5")).toBe(
			BUDGET_WEIGHT_MIN,
		);
		expect(budgetTokenWeight("gpt-6-astra", "gpt-6-luna")).toBe(
			BUDGET_WEIGHT_MAX,
		);
		const sonnetVsSol = budgetTokenWeight(
			"anthropic/claude-sonnet-5.5",
			"openai/gpt-6.1-sol",
		);
		expect(sonnetVsSol).toBeCloseTo(
			referenceTokenPrice({ input: 2, output: 10, cacheRead: 0.1 }) /
				referenceTokenPrice({ input: 2, output: 10, cacheRead: 0.1 }),
		);
		expect(budgetTokenWeight("acme/unknown", "gpt-6.1-sol")).toBe(1);
		expect(budgetTokenWeight("x/y:free", "gpt-6.1-sol")).toBe(
			BUDGET_WEIGHT_MIN,
		);
		expect(budgetTokenWeight("gpt-6-luna", undefined)).toBe(1);
	});
});

describe("Bedrock OpenAI prices", () => {
	const million = (fields: Record<string, number>) => ({
		inputTokens: null,
		outputTokens: null,
		uncachedInputTokens: null,
		cacheReadTokens: null,
		cacheWriteTokens: null,
		...fields,
	});

	it("maps foundation ids and inference profiles onto the catalog id", () => {
		expect(pricedModelId("openai.gpt-6.1-sol")).toBe("gpt-6.1-sol");
		expect(pricedModelId("global.openai.gpt-6-luna")).toBe("gpt-6-luna");
		expect(pricedModelId("us.openai.gpt-6.1-sol")).toBe("gpt-6.1-sol");
		expect(pricedModelId("us-gov.openai.gpt-6.1-sol")).toBe("gpt-6.1-sol");
	});

	it("bills the global profile at list price and a regional one 10% above it", () => {
		expect(modelPrice("global.openai.gpt-6.1-sol")).toEqual(
			KNOWN_MODEL_PRICES["openai/gpt-6.1-sol"],
		);
		const regional = modelPrice("us.openai.gpt-6-luna");
		expect(regional?.input).toBeCloseTo(0.11, 10);
		expect(regional?.cacheRead).toBeCloseTo(0.011, 10);
		expect(regional?.cacheWrite).toBeCloseTo(0.1375, 10);
		expect(regional?.output).toBeCloseTo(0.55, 10);
		expect(regional?.longContext?.aboveInputTokens).toBe(272_000);
		expect(regional?.longContext?.input).toBeCloseTo(0.22, 10);
	});

	it("prices cache writes and the long-context tier for Sol", () => {
		const billing = modelBilling({
			harness: "api",
			modelId: "global.openai.gpt-6.1-sol",
		});
		// 1M uncached + 1M cache reads + 1M cache writes + 1M output, base tier.
		const base = million({
			inputTokens: 3_000_000,
			outputTokens: 1_000_000,
			cacheReadTokens: 1_000_000,
			cacheWriteTokens: 1_000_000,
		});
		expect(usageCostUsd(base, billing)).toBeCloseTo(2 + 0.1 + 2.5 + 10, 10);
		// One 300K-input request above 272K: the whole request at the long tier.
		const long = requestTokenUsage(
			million({
				inputTokens: 300_000,
				outputTokens: 10_000,
				cacheReadTokens: 200_000,
				cacheWriteTokens: 50_000,
			}),
			longContextThreshold("global.openai.gpt-6.1-sol"),
		);
		expect(usageCostUsd(long, billing)).toBeCloseTo(
			(50_000 * 4 + 200_000 * 0.2 + 50_000 * 5 + 10_000 * 15) / 1_000_000,
			10,
		);
	});
});

describe("openaiDirectCostUsd", () => {
	const usage = {
		inputTokens: 1_000_000,
		outputTokens: 100_000,
		uncachedInputTokens: 50_000,
		cacheReadTokens: 900_000,
		cacheWriteTokens: 50_000,
	};

	it("bills OpenAI's way: list price, cache writes as plain input", () => {
		// 100k uncached x $2 + 900k cached x $0.10 + 100k output x $10.
		expect(openaiDirectCostUsd(usage, "openai.gpt-6.1-sol")).toBeCloseTo(
			1.29,
			6,
		);
		expect(openaiDirectCostUsd(usage, "global.openai.gpt-6.1-sol")).toBeCloseTo(
			1.29,
			6,
		);
		expect(openaiDirectCostUsd(usage, "gpt-6.1-sol")).toBeCloseTo(1.29, 6);
	});

	it("is below the Bedrock in-Region bill for the same tokens", () => {
		const bedrock = usageCostUsd(
			usage,
			modelBilling({ harness: "api", modelId: "openai.gpt-6.1-sol" }),
		);
		expect(bedrock).toBeGreaterThan(
			openaiDirectCostUsd(usage, "openai.gpt-6.1-sol") ?? 0,
		);
	});

	it("is null for models that are not OpenAI's", () => {
		expect(openaiDirectCostUsd(usage, "claude-opus-5.5")).toBeNull();
	});
});
