import { describe, expect, it } from "vitest";
import { SessionItemId } from "./ids";
import { modelBilling, usageCostUsd } from "./model-pricing";
import type { SessionItem } from "./session-item";
import {
	agentSpend,
	budgetUsageTokens,
	forkVmMinutes,
	formatSpend,
	sessionTokenUsage,
	subtreeSpends,
	totalSpend,
} from "./subagent-usage";

const turn = (id: string, input: number, output: number, costUsd?: number) =>
	({
		kind: "userMessage",
		id: SessionItemId(id),
		text: id,
		apiUsage: {
			inputTokens: input,
			outputTokens: output,
			uncachedInputTokens: input,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			...(costUsd === undefined ? {} : { costUsd }),
		},
	}) satisfies SessionItem;

describe("model pricing", () => {
	it("bills a subscription by plan and unknown models as tokens only", () => {
		expect(modelBilling({ harness: "codex", modelId: "gpt-6.1-sol" })).toEqual({
			kind: "plan",
			price: expect.objectContaining({ input: 2, output: 10, cacheRead: 0.1 }),
		});
		expect(
			modelBilling({ harness: "api", modelId: "acme/unknown-model" }),
		).toEqual({ kind: "tokens", price: null });
		const sonnet = modelBilling({
			harness: "api",
			modelId: `api/${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}/${encodeURIComponent("anthropic/claude-sonnet-5.5")}`,
		});
		expect(sonnet).toMatchObject({ kind: "tokens", price: { input: 2 } });
	});

	it("prefers the provider's reported dollars over list price", () => {
		const billing = modelBilling({
			harness: "api",
			modelId: "anthropic/claude-sonnet-5.5",
		});
		const usage = {
			inputTokens: 1_000_000,
			outputTokens: 100_000,
			uncachedInputTokens: 200_000,
			cacheReadTokens: 800_000,
			cacheWriteTokens: 0,
		};
		// 0.2M × $2 + 0.8M × $0.1 + 0.1M × $10
		expect(usageCostUsd(usage, billing)).toBeCloseTo(0.4 + 0.08 + 1);
		expect(usageCostUsd({ ...usage, costUsd: 0.5 }, billing)).toBe(0.5);
		// A plan route: the list-price estimate, never a reported charge.
		expect(
			usageCostUsd(
				{ ...usage, costUsd: 0.5 },
				{ kind: "plan", price: billing.price },
			),
		).toBeCloseTo(1.48);
		expect(usageCostUsd(usage, { kind: "plan", price: null })).toBeNull();
		expect(usageCostUsd(usage, { kind: "tokens", price: null })).toBeNull();
	});
});

describe("subagent spend", () => {
	it("sums every turn's usage in a session", () => {
		expect(
			sessionTokenUsage([turn("a", 100, 10), turn("b", 50, 5)])?.inputTokens,
		).toBe(150);
		expect(sessionTokenUsage([])).toBeNull();
	});

	it("aggregates own spend into subtree totals and a tree total", () => {
		const billing = { kind: "tokens" as const, price: { input: 1, output: 1 } };
		const root = agentSpend({ items: [turn("r", 1_000_000, 0)], billing });
		const writer = agentSpend({
			items: [turn("w", 500_000, 0)],
			billing,
			vmMinutes: 12,
		});
		const grandchild = agentSpend({
			items: [turn("g", 250_000, 0)],
			billing: { kind: "tokens", price: null },
		});
		const totals = subtreeSpends([
			{ id: "root", parentId: null, spend: root },
			{ id: "1", parentId: "root", spend: writer },
			{ id: "1.1", parentId: "1", spend: grandchild },
		]);
		expect(totals.get("1.1")?.tokens).toBe(250_000);
		expect(totals.get("1")).toMatchObject({
			tokens: 750_000,
			vmMinutes: 12,
			// The grandchild's price is unknown, so the subtree's dollars are too.
			costUsd: null,
		});
		expect(totals.get("root")?.tokens).toBe(1_750_000);
		expect(totalSpend([root, writer]).costUsd).toBeCloseTo(1.5);
		expect(formatSpend(totals.get("root") ?? root)).toEqual({
			tokens: "1.75M",
			dollars: "$?",
			vm: "12.0 VM min",
		});
	});

	it("counts a fork's VM minutes from boot to deletion, or to now while it lives", () => {
		const bootedAt = "2026-10-17T10:00:00.000Z";
		expect(
			forkVmMinutes(
				{ bootedAt, deletedAt: "2026-10-17T10:30:00.000Z" },
				Date.parse("2026-10-17T12:00:00.000Z"),
			),
		).toBe(30);
		expect(
			forkVmMinutes({ bootedAt }, Date.parse("2026-10-17T10:06:00.000Z")),
		).toBe(6);
		expect(forkVmMinutes(null, Date.now())).toBe(0);
	});

	it("stops a finished writer's VM minutes at its finish, not at the fork's later deletion", () => {
		const bootedAt = "2026-10-17T10:00:00.000Z";
		const finished = Date.parse("2026-10-17T10:01:18.000Z");
		// Kept for a follow-up, deleted 30 minutes later: still 1.3 minutes.
		expect(
			forkVmMinutes(
				{ bootedAt },
				Date.parse("2026-10-17T10:05:36.000Z"),
				finished,
			),
		).toBeCloseTo(1.3);
		expect(
			forkVmMinutes(
				{ bootedAt, deletedAt: "2026-10-17T10:31:18.000Z" },
				Date.parse("2026-10-17T12:00:00.000Z"),
				finished,
			),
		).toBeCloseTo(1.3);
	});

	it("labels a plan-billed spend as a list-price estimate, or plan when unpriced", () => {
		const spend = agentSpend({
			items: [turn("p", 1_000_000, 100_000)],
			billing: { kind: "plan", price: { input: 1, output: 10 } },
		});
		expect(spend.costUsd).toBeCloseTo(2);
		expect(formatSpend(spend).dollars).toBe("~$2.00 list-price est. (plan)");
		expect(
			formatSpend(
				agentSpend({
					items: [turn("q", 2000, 100)],
					billing: { kind: "plan", price: null },
				}),
			).dollars,
		).toBe("plan");
	});
});

describe("budgetUsageTokens", () => {
	it("counts cache reads at a tenth, the rest in full", () => {
		expect(
			budgetUsageTokens({
				inputTokens: 900_000,
				outputTokens: 20_000,
				uncachedInputTokens: 100_000,
				cacheReadTokens: 800_000,
				cacheWriteTokens: 0,
			}),
		).toBe(200_000);
		expect(
			budgetUsageTokens({
				inputTokens: 1_000,
				outputTokens: 10,
				uncachedInputTokens: null,
				cacheReadTokens: null,
				cacheWriteTokens: null,
			}),
		).toBe(1_010);
		expect(budgetUsageTokens(null)).toBe(0);
	});
});
