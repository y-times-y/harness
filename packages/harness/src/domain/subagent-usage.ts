import { type ApiTokenUsage, addApiTokenUsage } from "./api-token-usage";
import {
	type ModelBilling,
	modelPrice,
	referenceTokenPrice,
	usageCostUsd,
} from "./model-pricing";
import type { SessionItem } from "./session-item";

/**
 * Cost accounting for a subagent tree: tokens and dollars per agent (from
 * the usage each turn records on its user message) and VM minutes for
 * forked writers. Readers share the parent's VM, so they add no VM minutes.
 */

/** One agent's own spend, children excluded. */
export type AgentSpend = {
	readonly tokens: number;
	/**
	 * Tokens as budgets count them: weighted by this agent's price relative to
	 * the tree's basis model (the builder's), so a cheaper child's tokens count
	 * for less (budgetTokenWeight). Equal to `tokens` when every model in the
	 * tree has the same price or a price is unknown.
	 */
	readonly budgetTokens: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	/**
	 * Dollars: billed (the provider's reported cost or list price × tokens)
	 * or, when planBilled, a list-price estimate of what the same tokens
	 * would cost on the API. Null when some usage has no known price.
	 */
	readonly costUsd: number | null;
	/** Some of it ran on a plan (a ChatGPT plan): costUsd is then an estimate, not a charge. */
	readonly planBilled: boolean;
	readonly vmMinutes: number;
};

export const NO_SPEND: AgentSpend = {
	tokens: 0,
	budgetTokens: 0,
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	costUsd: 0,
	planBilled: false,
	vmMinutes: 0,
};

/** Every turn's recorded usage in a session, summed. */
export function sessionTokenUsage(
	items: readonly SessionItem[],
): ApiTokenUsage | null {
	let total: ApiTokenUsage | null = null;
	for (const item of items)
		if (item.kind === "userMessage" && item.apiUsage)
			total = addApiTokenUsage(total, item.apiUsage);
	return total;
}

/** Input plus output tokens, unknown counted as zero. */
export function usageTokens(usage: ApiTokenUsage | null | undefined) {
	return (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
}

/** What one cache-read token counts in a budget: about its price share of a fresh input token. */
export const CACHE_READ_BUDGET_SHARE = 0.1;

/**
 * Tokens as a subagent's budget counts them: input plus output, with cache
 * reads at CACHE_READ_BUDGET_SHARE. Every step re-reads the cached history,
 * so counting reads in full ends a long round on its history alone.
 */
export function budgetUsageTokens(usage: ApiTokenUsage | null | undefined) {
	const reads = Math.min(usage?.cacheReadTokens ?? 0, usage?.inputTokens ?? 0);
	return usageTokens(usage) - reads * (1 - CACHE_READ_BUDGET_SHARE);
}

/** Budget weights are clamped: a free or very cheap child gets at most 4× the raw tokens (the hard cap). */
export const BUDGET_WEIGHT_MIN = 0.25;
export const BUDGET_WEIGHT_MAX = 4;

/**
 * How much one of `modelId`'s tokens counts against a budget set in the
 * basis model's tokens: their reference prices' ratio (a typical agent mix,
 * mostly cache reads), clamped to [BUDGET_WEIGHT_MIN, BUDGET_WEIGHT_MAX].
 * 1 when either price is unknown; a `:free` route weighs the minimum.
 */
export function budgetTokenWeight(
	modelId: string | null | undefined,
	basisModelId: string | null | undefined,
) {
	if (!modelId || !basisModelId || modelId === basisModelId) return 1;
	if (/:free$/.test(modelId)) return BUDGET_WEIGHT_MIN;
	const model = modelPrice(modelId);
	const basis = modelPrice(basisModelId);
	if (!model || !basis) return 1;
	const ratio = referenceTokenPrice(model) / referenceTokenPrice(basis);
	if (!Number.isFinite(ratio)) return 1;
	return Math.min(BUDGET_WEIGHT_MAX, Math.max(BUDGET_WEIGHT_MIN, ratio));
}

export function agentSpend(input: {
	readonly items: readonly SessionItem[];
	readonly billing: ModelBilling;
	readonly vmMinutes?: number;
	/** budgetTokenWeight of this agent's model against the tree's basis. */
	readonly budgetWeight?: number;
}): AgentSpend {
	const usage = sessionTokenUsage(input.items);
	const tokens = usageTokens(usage);
	return {
		tokens,
		budgetTokens: Math.round(tokens * (input.budgetWeight ?? 1)),
		inputTokens: usage?.inputTokens ?? 0,
		outputTokens: usage?.outputTokens ?? 0,
		cacheReadTokens: usage?.cacheReadTokens ?? 0,
		costUsd: usageCostUsd(usage, input.billing),
		planBilled: input.billing.kind === "plan",
		vmMinutes: input.vmMinutes ?? 0,
	};
}

/** Sums spends; dollars stay known only while every part is known. */
export function totalSpend(spends: readonly AgentSpend[]): AgentSpend {
	return spends.reduce(
		(total, spend) => ({
			tokens: total.tokens + spend.tokens,
			budgetTokens: total.budgetTokens + spend.budgetTokens,
			inputTokens: total.inputTokens + spend.inputTokens,
			outputTokens: total.outputTokens + spend.outputTokens,
			cacheReadTokens: total.cacheReadTokens + spend.cacheReadTokens,
			costUsd:
				total.costUsd === null || spend.costUsd === null
					? null
					: total.costUsd + spend.costUsd,
			planBilled: total.planBilled || spend.planBilled,
			vmMinutes: total.vmMinutes + spend.vmMinutes,
		}),
		NO_SPEND,
	);
}

/**
 * A forked VM's minutes from boot to deletion (or now while it lives),
 * stopped at `endedAt` once its writer finished: the fork is kept a while
 * for a follow-up (teardownSubagentForks) but pauses itself when idle
 * (PRODUCT_IDLE_TIMEOUT_SECONDS) and the provider meters only running
 * time, so the wait for deletion is not counted.
 */
export function forkVmMinutes(
	fork: { readonly bootedAt?: string; readonly deletedAt?: string } | null,
	now: number,
	endedAt?: number | null,
) {
	if (!fork?.bootedAt) return 0;
	const start = Date.parse(fork.bootedAt);
	const end = Math.min(
		fork.deletedAt ? Date.parse(fork.deletedAt) : now,
		endedAt ?? Number.POSITIVE_INFINITY,
	);
	return Number.isFinite(start) && Number.isFinite(end) && end > start
		? (end - start) / 60_000
		: 0;
}

/**
 * Each node's subtree total (its own spend plus every descendant's), keyed
 * by id. Budgets compare subtree tokens: a child's allowance covers its own
 * children too.
 */
export function subtreeSpends(
	nodes: readonly {
		readonly id: string;
		readonly parentId: string | null;
		readonly spend: AgentSpend;
	}[],
): Map<string, AgentSpend> {
	const children = new Map<string, string[]>();
	for (const node of nodes)
		if (node.parentId)
			children.set(node.parentId, [
				...(children.get(node.parentId) ?? []),
				node.id,
			]);
	const own = new Map(nodes.map((node) => [node.id, node.spend]));
	const totals = new Map<string, AgentSpend>();
	const visit = (id: string, seen: Set<string>): AgentSpend => {
		const known = totals.get(id);
		if (known) return known;
		if (seen.has(id)) return NO_SPEND;
		seen.add(id);
		const total = totalSpend([
			own.get(id) ?? NO_SPEND,
			...(children.get(id) ?? []).map((child) => visit(child, seen)),
		]);
		totals.set(id, total);
		return total;
	};
	for (const node of nodes) visit(node.id, new Set());
	return totals;
}

export function formatSpend(spend: AgentSpend) {
	const tokens =
		spend.tokens >= 1_000_000
			? `${(spend.tokens / 1_000_000).toFixed(2)}M`
			: spend.tokens >= 1000
				? `${Math.round(spend.tokens / 1000)}k`
				: String(spend.tokens);
	const dollars =
		spend.costUsd === null
			? spend.planBilled
				? "plan"
				: "$?"
			: spend.planBilled
				? `~$${spend.costUsd.toFixed(2)} list-price est. (plan)`
				: `$${spend.costUsd.toFixed(2)}`;
	return {
		tokens,
		dollars,
		vm: spend.vmMinutes ? `${spend.vmMinutes.toFixed(1)} VM min` : "",
	};
}
