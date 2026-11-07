import { z } from "zod";
import { API_MODEL_LIST } from "./api-model-list";
import { type ApiTurnSettings, apiTurnSettings } from "./api-turn-settings";
import {
	CLAUDE_CODE_KEY,
	CLAUDE_CODE_LABEL,
	CLAUDE_CODE_MODEL_EQUIVALENTS,
	claudeCodeTurnRevision,
	isClaudeCodeRevision,
} from "./claude-code-route";
import { isDevelopmentEnvironment } from "./development-environment";
import {
	directAuthor,
	isCustomConnection,
	type ModelProvider,
} from "./model-connection";
import type { ModelSwitchItem, SessionItem } from "./session-item";
import {
	subscriptionTurnRevision,
	subscriptionTurnSettings,
} from "./subscription-turn";

/**
 * Automatic model failover: when the serving connection is down, the turn's
 * next model step continues on the next best route. Only provider-side
 * failures qualify; a request the provider rejects on its merits (invalid,
 * too long, refused) or that only the user can fix (a revoked login or key)
 * fails the same way anywhere and never moves.
 */
export type FailoverReason =
	| "outage"
	| "overloaded"
	| "rate-limited"
	| "usage-limit"
	| "timeout"
	/** A subscription sign-in (SuperGrok) was rejected; only the user can renew it. */
	| "plan-access"
	/** A subscription token the provider refused (a Claude setup-token). */
	| "signed-out"
	/** A fallback's provider account has no credit left (HTTP 402). */
	| "out-of-credit"
	/** A fallback's API key was refused (HTTP 401 or 403). */
	| "key-refused";

const REASON_TEXT: Record<FailoverReason, string> = {
	outage: "outage",
	overloaded: "overloaded",
	"rate-limited": "rate limited",
	"usage-limit": "usage limit reached",
	timeout: "timed out",
	"plan-access": "sign-in needs renewing",
	"signed-out": "token refused",
	"out-of-credit": "out of credit",
	"key-refused": "key refused",
};

/** Why a route stopped, for the person reading the chat. */
function failingSentence(from: RouteLabel, reason: FailoverReason) {
	if (reason === "usage-limit")
		return from.connection === SUBSCRIPTION_LABEL
			? "Your ChatGPT plan's Codex usage is used up"
			: from.connection === CLAUDE_CODE_LABEL
				? "Your Claude plan's usage is used up"
				: `${from.connection} is out of usage`;
	if (reason === "signed-out")
		return from.connection === CLAUDE_CODE_LABEL
			? "Anthropic refused your Claude token"
			: `${from.connection} refused its sign-in`;
	if (reason === "key-refused" && from.connection === SUBSCRIPTION_LABEL)
		return "Codex needs reconnecting in Settings";
	return {
		outage: `${from.connection} is down right now`,
		overloaded: `${from.connection} is overloaded right now`,
		"rate-limited": `${from.connection} is limiting requests right now`,
		timeout: `${from.connection} stopped responding`,
		"plan-access": `${from.connection} needs reconnecting in Settings`,
		"out-of-credit": `${from.connection} is out of credit`,
		"key-refused": `${from.connection} refused its key`,
	}[reason];
}

/** The transcript text a "Continue on …" answer sends. */
export const FAILOVER_CONTINUE_TEXT = "Continue on the fallback model.";

/** The ChatGPT plan's connection as the chat names it. */
export const SUBSCRIPTION_LABEL = "Codex";

/** The ChatGPT plan connection's key; API connections use their id. */
export const SUBSCRIPTION_KEY = "codex";

/** What serves a model step: a connection (or the subscription), its revision and a model. */
export type ModelRoute = {
	readonly connectionId: string | null;
	readonly connectionRevision: string;
	readonly modelId: string;
	readonly settings?: ApiTurnSettings;
};

/** The connection a route uses: an API connection's id, or which subscription. */
export function routeConnectionKey(
	route: Pick<ModelRoute, "connectionId"> &
		Partial<Pick<ModelRoute, "connectionRevision">>,
) {
	if (route.connectionId) return route.connectionId;
	return isClaudeCodeRevision(route.connectionRevision)
		? CLAUDE_CODE_KEY
		: SUBSCRIPTION_KEY;
}

export function routeKey(
	route: Pick<ModelRoute, "connectionId" | "modelId"> &
		Partial<Pick<ModelRoute, "connectionRevision">>,
) {
	return `${routeConnectionKey(route)}|${route.modelId}`;
}

/**
 * Subscriptions are prepaid; keys and gateways bill the user's provider
 * account. "subscription" is the ChatGPT plan (its own route); "plan" is a
 * prepaid plan reached as an API connection (SuperGrok).
 */
export type FailoverConnectionKind =
	| "subscription"
	| "plan"
	| "key"
	| "gateway"
	| "custom";

export type FailoverModel = {
	readonly id: string;
	readonly label: string;
	/** Reasoning levels this route accepts; absent means none can be carried over. */
	readonly reasoning?: readonly string[];
};

export type FailoverConnection = {
	readonly key: string;
	readonly label: string;
	readonly kind: FailoverConnectionKind;
	readonly provider?: ModelProvider;
	readonly baseUrl?: string;
	/** The API connection's revision; unused for the subscription. */
	readonly revision: string;
	/** What this connection can serve now; empty when its catalog is unreachable. */
	readonly models: readonly FailoverModel[];
};

export function failoverConnectionKind(connection: {
	provider: ModelProvider;
	baseUrl: string;
	subscription?: unknown;
}): FailoverConnectionKind {
	if (connection.subscription) return "plan";
	if (connection.provider === "openrouter") return "gateway";
	return isCustomConnection(connection) ? "custom" : "key";
}

/** Prepaid plans: moving off one onto a key bills the user. */
export function prepaidKind(kind: FailoverConnectionKind): boolean {
	return kind === "subscription" || kind === "plan";
}

const KIND_RANK: Record<FailoverConnectionKind, number> = {
	subscription: 0,
	plan: 0,
	key: 1,
	gateway: 2,
	custom: 3,
};

/**
 * The user's order first (keys they ranked, while those connections still
 * exist), then everything else by default: subscriptions, direct keys,
 * gateways, custom endpoints, each in the order they were added.
 */
export function orderedFailoverConnections<
	T extends Pick<FailoverConnection, "key" | "kind">,
>(connections: readonly T[], preferred: readonly string[] = []): T[] {
	const rank = (connection: T) => {
		const index = preferred.indexOf(connection.key);
		return index >= 0 ? index : preferred.length + KIND_RANK[connection.kind];
	};
	return connections
		.map((connection, index) => ({ connection, index }))
		.sort(
			(a, b) => rank(a.connection) - rank(b.connection) || a.index - b.index,
		)
		.map(({ connection }) => connection);
}

/**
 * ChatGPT plan slugs that are the same model as a listed API model.
 * Explicit: a slug is never matched by string similarity.
 */
export const SUBSCRIPTION_MODEL_EQUIVALENTS: Readonly<Record<string, string>> =
	{
		"gpt-6.1-sol": "openai/gpt-6.1-sol",
		"gpt-6-astra": "openai/gpt-6-astra",
		"gpt-6-luna": "openai/gpt-6-luna",
	};

export type ModelTier = "frontier" | "balanced" | "fast";

/**
 * Comparable models by tier, keyed by their OpenRouter id (the canonical id),
 * in fallback preference order. A model absent from this table only fails
 * over to itself on another connection.
 */
export const MODEL_TIERS: Readonly<Record<ModelTier, readonly string[]>> = {
	frontier: [
		"openai/gpt-6.1-sol",
		"anthropic/claude-opus-5.5",
		"google/gemini-4-argon",
		"openai/gpt-6-astra",
		"x-ai/grok-4.7",
	],
	balanced: ["anthropic/claude-sonnet-5.5", "x-ai/grok-4.6"],
	fast: [
		"openai/gpt-6-luna",
		"anthropic/claude-haiku-5.5",
		"google/gemini-3.8-flash",
		"google/gemini-3.7-flash",
	],
};

export function modelTier(canonical: string): ModelTier | null {
	for (const [tier, models] of Object.entries(MODEL_TIERS))
		if (models.includes(canonical)) return tier as ModelTier;
	return null;
}

/** The listed model a route's id names, as its OpenRouter id, or null when it is not listed. */
export function canonicalModelId(
	connection: Pick<FailoverConnection, "kind" | "provider" | "baseUrl">,
	modelId: string,
): string | null {
	switch (connection.kind) {
		case "subscription":
			return (
				SUBSCRIPTION_MODEL_EQUIVALENTS[modelId] ??
				CLAUDE_CODE_MODEL_EQUIVALENTS[modelId] ??
				null
			);
		case "gateway":
			return API_MODEL_LIST.some((entry) => entry.openRouterId === modelId)
				? modelId
				: null;
		case "plan":
		case "key": {
			const author =
				connection.provider && connection.baseUrl
					? directAuthor({
							provider: connection.provider,
							baseUrl: connection.baseUrl,
						})
					: null;
			return (
				API_MODEL_LIST.find(
					(entry) => entry.author === author && entry.directId === modelId,
				)?.openRouterId ?? null
			);
		}
		case "custom":
			return (
				API_MODEL_LIST.find(
					(entry) =>
						entry.openRouterId === modelId || entry.directId === modelId,
				)?.openRouterId ?? null
			);
	}
}

/** Same-tier models nearest first: the same maker, then the tier's preference order. */
function closestModels(canonical: string): string[] {
	const tier = modelTier(canonical);
	if (!tier) return [];
	const author = canonical.split("/")[0];
	return MODEL_TIERS[tier]
		.filter((id) => id !== canonical)
		.map((id, index) => ({ id, index }))
		.sort(
			(a, b) =>
				Number(b.id.split("/")[0] === author) -
					Number(a.id.split("/")[0] === author) || a.index - b.index,
		)
		.map(({ id }) => id);
}

export type FailoverCandidate = {
	readonly route: ModelRoute;
	readonly connectionKey: string;
	readonly connectionLabel: string;
	readonly modelLabel: string;
	/** Billed to the user's own provider account rather than a subscription. */
	readonly paid: boolean;
	/** The user's chosen model, on another connection. */
	readonly sameModel: boolean;
};

/** The reasoning level the user chose for the original route, if any. */
function chosenReasoning(route: ModelRoute) {
	if (route.connectionId === null)
		return subscriptionTurnSettings(route.connectionRevision)?.reasoning;
	return route.settings?.reasoning;
}

function candidateRoute(
	connection: FailoverConnection,
	model: FailoverModel,
	reasoning: string | undefined,
): ModelRoute {
	const kept =
		reasoning && model.reasoning?.includes(reasoning) ? reasoning : undefined;
	if (connection.kind === "subscription" && connection.key === CLAUDE_CODE_KEY)
		return {
			connectionId: null,
			connectionRevision: claudeCodeTurnRevision(),
			modelId: model.id,
		};
	if (connection.kind === "subscription")
		return {
			connectionId: null,
			connectionRevision: subscriptionTurnRevision(kept, false),
			modelId: model.id,
		};
	// A faster (pricier) speed is never carried to a fallback.
	return {
		connectionId: connection.key,
		connectionRevision: connection.revision,
		modelId: model.id,
		settings: kept ? { reasoning: kept } : {},
	};
}

/**
 * Where a turn may continue, best first. By default the user's prepaid
 * subscriptions come before anything billed to a key: on each side, the
 * user's model through another connection first, then the closest same-tier
 * model. A connection order the user saved ranks connections instead, one at
 * a time, each offering the same model before the closest ones. Routes
 * already tried this turn, and connections found unusable, are never offered
 * again, so a turn cannot loop.
 */
export function failoverCandidates(input: {
	readonly original: ModelRoute;
	readonly connections: readonly FailoverConnection[];
	readonly order?: readonly string[];
	readonly tried: readonly string[];
	/** Connections that cannot serve this turn at all (refused, out of credit). */
	readonly excludedConnections?: readonly string[];
	readonly sameModelOnly?: boolean;
	/** Custom endpoints are unreachable from the hosted executor. */
	readonly allowCustom?: boolean;
}): FailoverCandidate[] {
	const originalKey = routeConnectionKey(input.original);
	const originalConnection =
		input.connections.find((row) => row.key === originalKey) ??
		(originalKey === SUBSCRIPTION_KEY || originalKey === CLAUDE_CODE_KEY
			? { kind: "subscription" as const }
			: null);
	const canonical = originalConnection
		? canonicalModelId(originalConnection, input.original.modelId)
		: null;
	const excluded = new Set(input.excludedConnections ?? []);
	const connections = orderedFailoverConnections(
		input.connections.filter(
			(row) =>
				(row.kind !== "custom" || input.allowCustom !== false) &&
				!excluded.has(row.key),
		),
		input.order,
	);
	const ranked = (input.order ?? []).some((key) =>
		input.connections.some((row) => row.key === key),
	);
	const band = (connection: FailoverConnection) =>
		ranked
			? connections.indexOf(connection)
			: prepaidKind(connection.kind)
				? 0
				: 1;
	const reasoning = chosenReasoning(input.original);
	const tried = new Set(input.tried);
	const candidates: FailoverCandidate[] = [];
	const offer = (
		within: readonly FailoverConnection[],
		wanted: string | null,
		sameModel: boolean,
	) => {
		for (const connection of within)
			for (const model of connection.models) {
				const matches = wanted
					? canonicalModelId(connection, model.id) === wanted
					: connection.key === originalKey &&
						model.id === input.original.modelId;
				if (!matches) continue;
				const route = candidateRoute(connection, model, reasoning);
				const key = routeKey(route);
				if (tried.has(key)) continue;
				tried.add(key);
				candidates.push({
					route,
					connectionKey: connection.key,
					connectionLabel: connection.label,
					modelLabel: model.label,
					paid: !prepaidKind(connection.kind),
					sameModel,
				});
			}
	};
	const closest =
		canonical && !input.sameModelOnly ? closestModels(canonical) : [];
	for (const current of [...new Set(connections.map(band))]) {
		const within = connections.filter((row) => band(row) === current);
		offer(within, canonical, true);
		for (const model of closest) offer(within, model, false);
	}
	return candidates;
}

/** At most this many switches per turn; then the turn fails, listing what was tried. */
export const MAX_TURN_FAILOVERS = 3;

/**
 * A fallback that cannot serve at all (out of credit, its key refused) moves
 * the turn on at most this many times; then the turn fails, saying why.
 */
export const MAX_FALLBACK_HOPS = 2;

/** A fallback's own account problem: it moves a turn only once the turn already failed over. */
export function fallbackAccountFailure(reason: FailoverReason) {
	return reason === "out-of-credit" || reason === "key-refused";
}

/** Failures that rule out every model on the connection, not just this one. */
export function connectionWideFailure(reason: FailoverReason) {
	return (
		fallbackAccountFailure(reason) ||
		reason === "signed-out" ||
		reason === "plan-access"
	);
}

export type FailoverPolicy = "any-model" | "same-model" | "off";

/**
 * Evaluation runs stay pinned to their model and connection. Child agents may move only to the same model on another
 * connection: their parent chose that model for the task.
 */
export function turnFailoverPolicy(input: {
	readonly enabled: boolean;
	readonly evaluation: boolean;
	readonly child: boolean;
}): FailoverPolicy {
	if (!input.enabled || input.evaluation) return "off";
	return input.child ? "same-model" : "any-model";
}

export type FailoverDecision =
	| { readonly kind: "switch"; readonly candidate: FailoverCandidate }
	| { readonly kind: "ask"; readonly candidate: FailoverCandidate }
	| { readonly kind: "stop" };

export function decideFailover(input: {
	readonly policy: FailoverPolicy;
	readonly switches: number;
	readonly serving: ModelRoute;
	readonly candidates: readonly FailoverCandidate[];
	readonly askBeforePaid: boolean;
	/** Someone is there to answer a question (a root chat, not a child agent). */
	readonly canAsk: boolean;
	/** The serving route is prepaid; default: it is the ChatGPT plan. */
	readonly servingPrepaid?: boolean;
	/** Why the serving route failed; a fallback's account problem has its own bound. */
	readonly reason?: FailoverReason;
	/** Fallbacks this turn already left for their own account problem. */
	readonly fallbackHops?: number;
}): FailoverDecision {
	if (input.policy === "off" || input.switches >= MAX_TURN_FAILOVERS)
		return { kind: "stop" };
	if (
		input.reason &&
		fallbackAccountFailure(input.reason) &&
		(input.fallbackHops ?? 0) >= MAX_FALLBACK_HOPS
	)
		return { kind: "stop" };
	const candidate = input.candidates.find(
		(row) => input.policy === "any-model" || row.sameModel,
	);
	if (!candidate) return { kind: "stop" };
	// Moving from a prepaid subscription onto the user's own bill.
	if (
		input.askBeforePaid &&
		candidate.paid &&
		(input.servingPrepaid ?? input.serving.connectionId === null)
	)
		return input.canAsk ? { kind: "ask", candidate } : { kind: "stop" };
	return { kind: "switch", candidate };
}

export type RouteLabel = {
	readonly model: string;
	readonly connection: string;
};

/** A turn's failover state: the route now serving it and every route it tried. */
export type TurnFailover = {
	readonly route: ModelRoute;
	readonly label: RouteLabel;
	readonly tried: readonly string[];
	readonly triedLabels: readonly string[];
	readonly switches: number;
	/** Connection keys ruled out for the rest of the turn (refused, out of credit). */
	readonly excluded?: readonly string[];
	/** Switches made because a fallback itself could not serve (MAX_FALLBACK_HOPS). */
	readonly fallbackHops?: number;
};

const routeSchema = z.object({
	connectionId: z.string().nullable(),
	connectionRevision: z.string().min(1),
	modelId: z.string().min(1).max(512),
	settings: z.unknown().optional(),
});
const turnFailoverSchema = z.object({
	route: routeSchema,
	label: z.object({ model: z.string(), connection: z.string() }),
	tried: z.array(z.string()).max(32),
	triedLabels: z.array(z.string()).max(32),
	switches: z.number().int().min(0),
	excluded: z.array(z.string().max(64)).max(32).optional(),
	fallbackHops: z.number().int().min(0).optional(),
});

/** A stored failover column, or null when absent or unreadable (the turn then uses its own route). */
export function turnFailover(value: unknown): TurnFailover | null {
	const parsed = turnFailoverSchema.safeParse(value);
	if (!parsed.success) return null;
	const { settings, ...route } = parsed.data.route;
	return {
		...parsed.data,
		route: { ...route, settings: apiTurnSettings(settings) },
	};
}

type TurnRouteFields = {
	readonly connection_id: string | null;
	readonly connection_revision: string;
	readonly model_id: string;
	readonly settings?: unknown;
	readonly failover?: unknown;
};

/**
 * Same-route retries: a transient failure (outage, timeout, overloaded) is
 * retried on the serving route, after these waits, before the turn fails
 * over. The count lives in the failover column with the route it counts, so
 * a restarted executor resumes it; a step that succeeds clears it.
 */
export const MODEL_STEP_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000];

export type RouteRetry = { readonly route: string; readonly count: number };

/** The stored failover column: a switch, a retry count, both, or neither. */
export type TurnFailoverColumn = (TurnFailover | Record<never, never>) & {
	readonly retry?: RouteRetry;
};

const routeRetrySchema = z.object({
	route: z.string().max(1024),
	count: z.number().int().min(0),
});

/** Same-route retries the turn already made on `route`. */
export function routeRetries(value: unknown, route: ModelRoute): number {
	const parsed = routeRetrySchema.safeParse(
		value && typeof value === "object"
			? (value as { retry?: unknown }).retry
			: undefined,
	);
	return parsed.success && parsed.data.route === routeKey(route)
		? parsed.data.count
		: 0;
}

/** The failover column with `count` retries on `route` (none clears it). */
export function withRouteRetries(
	value: unknown,
	route: ModelRoute,
	count: number,
): TurnFailoverColumn {
	const failover = turnFailover(value) ?? {};
	return count > 0
		? { ...failover, retry: { route: routeKey(route), count } }
		: failover;
}

/** The route the user chose for this turn. */
export function chosenRoute(turn: TurnRouteFields): ModelRoute {
	return {
		connectionId: turn.connection_id,
		connectionRevision: turn.connection_revision,
		modelId: turn.model_id,
		settings: apiTurnSettings(turn.settings),
	};
}

/** The route serving this turn's next step: its fallback once it failed over (sticky for the turn). */
export function servingRoute(turn: TurnRouteFields): ModelRoute {
	return turnFailover(turn.failover)?.route ?? chosenRoute(turn);
}

/**
 * The state after moving to `candidate`; the route that just failed stays
 * tried, and its whole connection too when `reason` rules it out.
 */
export function nextTurnFailover(
	previous: TurnFailover | null,
	failing: { route: ModelRoute; label: RouteLabel },
	candidate: FailoverCandidate,
	reason?: FailoverReason,
): TurnFailover {
	const label = {
		model: candidate.modelLabel,
		connection: candidate.connectionLabel,
	};
	const tried = [...(previous?.tried ?? [])];
	const triedLabels = [...(previous?.triedLabels ?? [])];
	for (const [key, text] of [
		[routeKey(failing.route), routeLabelText(failing.label)],
		[routeKey(candidate.route), routeLabelText(label)],
	]) {
		if (tried.includes(key)) continue;
		tried.push(key);
		triedLabels.push(text);
	}
	const excluded = [...(previous?.excluded ?? [])];
	const failingConnection = routeConnectionKey(failing.route);
	if (
		reason &&
		connectionWideFailure(reason) &&
		!excluded.includes(failingConnection)
	)
		excluded.push(failingConnection);
	const fallbackHops =
		(previous?.fallbackHops ?? 0) +
		(reason && fallbackAccountFailure(reason) ? 1 : 0);
	return {
		route: candidate.route,
		label,
		tried,
		triedLabels,
		switches: (previous?.switches ?? 0) + 1,
		...(excluded.length ? { excluded } : {}),
		...(fallbackHops ? { fallbackHops } : {}),
	};
}

/** The connections a turn may no longer move to: those it ruled out, and the one failing now when `reason` rules it out. */
export function excludedFailoverConnections(
	previous: TurnFailover | null,
	failing: ModelRoute,
	reason: FailoverReason | undefined,
): string[] {
	const excluded = [...(previous?.excluded ?? [])];
	if (reason && connectionWideFailure(reason))
		excluded.push(routeConnectionKey(failing));
	return [...new Set(excluded)];
}

export function routeLabelText(label: RouteLabel) {
	return label.model === label.connection
		? label.model
		: `${label.model} via ${label.connection}`;
}

export function failoverNotice(
	from: RouteLabel,
	to: RouteLabel,
	reason: FailoverReason,
) {
	return `${failingSentence(from, reason)}, so this chat continued on ${routeLabelText(to)}.`;
}

export function failoverQuestion(
	from: RouteLabel,
	to: RouteLabel,
	reason: FailoverReason,
) {
	return `${failingSentence(from, reason)}. Continue on ${routeLabelText(to)}? It bills your API key, and you asked to be asked first.`;
}

/** Appended to the turn's failure once it had moved at least once. */
export function failoverExhaustedDetail(failover: TurnFailover | null) {
	return failover && failover.triedLabels.length > 1
		? ` Tried: ${failover.triedLabels.join(", ")}.`
		: "";
}

/**
 * The turn's failure after a failover chain ran out, leading with why the
 * first route stopped (often the real reason, such as a spent ChatGPT plan)
 * rather than only the last fallback's error.
 */
export function failoverChainFailure(
	items: readonly SessionItem[],
	turnId: string,
	lastFailure: string,
	now = Date.now(),
) {
	const switches = items.filter(
		(item): item is ModelSwitchItem =>
			item.kind === "modelSwitch" &&
			item.state === "switched" &&
			item.id.startsWith(`${turnId}:switch-`) &&
			item.reason !== "sidekick-escalation",
	);
	const first = switches[0];
	if (!first || first.reason === "sidekick-escalation") return null;
	const fallbacks = [...new Set(switches.map((item) => item.to.connection))];
	const tried =
		fallbacks.length > 1
			? `${fallbacks.slice(0, -1).join(", ")} and ${fallbacks.at(-1)}`
			: first.to.connection;
	const minutes = first.resetsAt
		? Math.max(1, Math.ceil((first.resetsAt - now) / 60_000))
		: null;
	const resets =
		minutes === null
			? ""
			: ` (resets in ${minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`})`;
	return `${failingSentence(first.from, first.reason)}${resets}. Switching to ${tried} didn't work either: ${lastFailure}`;
}

/** The runtime note the next model reads after a switch; its earlier reasoning is gone. */
export function failoverRuntimeNote(
	from: RouteLabel,
	to: RouteLabel,
	reason: FailoverReason,
) {
	return `Runtime model switch: ${routeLabelText(from)} became unavailable (${REASON_TEXT[reason]}), so this same turn continues on ${routeLabelText(to)}. The history above is the conversation so far; the previous model's private reasoning is not available. Its last response may have been cut off: inspect the working tree and command state before repeating any change. This note is runtime status, not a new user request.`;
}

/**
 * Development only: `YTIMESY_DEV_FORCE_MODEL_OUTAGE=<connection>[@<step>]`
 * makes that connection ("codex" or an API connection id) answer HTTP 503
 * from that durable step on (from the first step without one). Only in
 * development (see isDevelopmentEnvironment), whatever the variable says.
 */
export function forcedDevelopmentOutage(
	env: {
		readonly YTIMESY_DEV_FORCE_MODEL_OUTAGE?: string;
		readonly YTIMESY_ENVIRONMENT?: string;
	},
	connectionKey: string,
	step: number,
): boolean {
	const value = env.YTIMESY_DEV_FORCE_MODEL_OUTAGE?.trim();
	if (!value || !isDevelopmentEnvironment(env)) return false;
	const [key, from] = value.split("@");
	const first = from ? Number.parseInt(from, 10) : 1;
	return key === connectionKey && Number.isFinite(first) && step >= first;
}
