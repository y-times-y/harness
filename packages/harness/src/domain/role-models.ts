import type { AgentProviderId } from "./agent-provider";
import { listedOpenRouterId } from "./api-model-list";
import { modelRouteId, parseModelRouteId } from "./model-connection";
import {
	canonicalModelId,
	type FailoverConnection,
	type FailoverModel,
	orderedFailoverConnections,
	SUBSCRIPTION_MODEL_EQUIVALENTS,
} from "./model-failover";

/**
 * A model per subagent role (harness variant `roleModels`, development):
 * the builder keeps the chat's model while its writers, researchers,
 * reviewers, the loops' checker and the attempt loop's tiebreak judge may run
 * on another route, e.g. a cheaper one. A role without an entry, or whose
 * entry the user cannot use, inherits the builder's model.
 */
export const MODEL_ROLES = [
	"writer",
	"researcher",
	"reviewer",
	"checker",
	"judge",
	/**
	 * Lead mode fusion: the model a stuck sidekick switches to at its next
	 * context compaction (src/server/services/sidekick-model-switch.ts); no
	 * switch without it.
	 */
	"writerEscalation",
	/**
	 * Lead mode fusion: the small model judging each sidekick round
	 * (src/domain/sidekick-classifier.ts); codex:gpt-6-luna@low when unset.
	 */
	"classifier",
	/**
	 * checkerMode=pair: the checker's worker, which reads, writes and runs
	 * the tests its judge (roleModels.checker) briefs
	 * (src/domain/checker-pair.ts); codex:gpt-6-luna when unset.
	 */
	"checkerWorker",
] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

/**
 * `model` is one of:
 * - `codex:<slug>`: the ChatGPT plan (Codex subscription), e.g. `codex:gpt-6-luna`;
 * - `api:<model>`: any of the user's API connections serving that model
 *   (its OpenRouter id or the maker's own id), e.g. `api:google/gemini-3.8-flash`;
 * - `api/<connection>/<model>`: one exact API route;
 * - `<model>`: the plan if it serves the model, else an API connection.
 * `effort` is the reasoning effort for that role (when unset, the parent
 * turn's effort if the route offers it, else the route's default).
 */
export type RoleModel = { readonly model: string; readonly effort?: string };
export type RoleModels = { readonly [Role in ModelRole]?: RoleModel };

const SPEC = /^[A-Za-z0-9._:/%+-]{1,600}$/;
const EFFORT = /^[a-z]{1,20}$/;

export function isModelRole(value: unknown): value is ModelRole {
	return (MODEL_ROLES as readonly unknown[]).includes(value);
}

/** `<model>` or `<model>@<effort>` (a flag value); throws on anything else. */
export function parseRoleModel(value: string): RoleModel {
	const [model, effort, ...rest] = value.trim().split("@");
	if (!model || !SPEC.test(model) || rest.length)
		throw new Error(
			`roleModels expects <model>[@<effort>] (e.g. codex:gpt-6-luna@low or api:google/gemini-3.8-flash); got "${value}".`,
		);
	if (effort !== undefined && !EFFORT.test(effort))
		throw new Error(
			`roleModels effort must be a level name such as low or high; got "${effort}".`,
		);
	return effort ? { model, effort } : { model };
}

/** A stored mapping; invalid roles or entries are dropped (a newer row never breaks a turn). */
export function roleModelsFromUnknown(value: unknown): RoleModels {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const out: Partial<Record<ModelRole, RoleModel>> = {};
	for (const [role, entry] of Object.entries(value)) {
		if (!isModelRole(role) || !entry || typeof entry !== "object") continue;
		const { model, effort } = entry as Record<string, unknown>;
		if (typeof model !== "string" || !SPEC.test(model)) continue;
		out[role] =
			typeof effort === "string" && EFFORT.test(effort)
				? { model, effort }
				: { model };
	}
	return out;
}

/** Flag form, in role order: `roleModels.checker=codex:gpt-6-luna@low`. */
export function roleModelsFlags(models: RoleModels): string[] {
	return MODEL_ROLES.flatMap((role) => {
		const entry = models[role];
		return entry
			? [
					`roleModels.${role}=${entry.model}${entry.effort ? `@${entry.effort}` : ""}`,
				]
			: [];
	});
}

/** roleModels.checkerWorker when unset. */
export const DEFAULT_CHECKER_WORKER_MODEL: RoleModel = {
	model: "codex:gpt-6-luna",
};

/**
 * The entry that applies to a role: the judge falls back to the reviewer's;
 * the checker's worker has a default (a cheaper model than its judge's).
 */
export function roleModelFor(
	models: RoleModels | undefined,
	role: ModelRole,
): RoleModel | undefined {
	if (role === "checkerWorker")
		return models?.checkerWorker ?? DEFAULT_CHECKER_WORKER_MODEL;
	if (!models) return undefined;
	return models[role] ?? (role === "judge" ? models.reviewer : undefined);
}

/** A child's model as the session stores it (`listedModelId`). */
export type ResolvedChildModel = {
	readonly harness: AgentProviderId;
	/** A ChatGPT plan slug, or an API route id `api/<connection>/<model>`. */
	readonly listedModelId: string;
	/** Reasoning effort for the child's turns; the route default when absent. */
	readonly reasoning?: string;
	readonly label: string;
};

export type RoleModelResolution =
	/** No entry for this role: the child inherits the parent's model. */
	| { readonly kind: "inherit" }
	| {
			readonly kind: "role";
			readonly model: ResolvedChildModel;
			/** Set when part of the entry (its effort) could not be applied. */
			readonly notice?: string;
	  }
	/** The entry names a route the user cannot use: the parent's model, with a notice. */
	| { readonly kind: "fallback"; readonly notice: string };

function canonical(id: string) {
	return listedOpenRouterId(id) ?? id;
}

function servesModel(
	connection: FailoverConnection,
	model: FailoverModel,
	wanted: string,
) {
	if (model.id === wanted) return true;
	const want = canonical(wanted);
	if (connection.kind === "subscription")
		return SUBSCRIPTION_MODEL_EQUIVALENTS[model.id] === want;
	return canonicalModelId(connection, model.id) === want;
}

function routeOf(
	connection: FailoverConnection,
	model: FailoverModel,
): ResolvedChildModel {
	return connection.kind === "subscription"
		? {
				harness: "codex",
				listedModelId: model.id,
				label: `${model.label} · ${connection.label}`,
			}
		: {
				harness: "api",
				listedModelId: modelRouteId(connection.key, model.id),
				label: `${model.label} · ${connection.label}`,
			};
}

function findRoute(
	spec: string,
	connections: readonly FailoverConnection[],
): { connection: FailoverConnection; model: FailoverModel } | null {
	const exact = parseModelRouteId(spec);
	if (exact) {
		const connection = connections.find(
			(row) => row.kind !== "subscription" && row.key === exact.connectionId,
		);
		const model = connection?.models.find((row) => row.id === exact.modelId);
		return connection && model ? { connection, model } : null;
	}
	const [prefix, ...rest] = spec.split(":");
	const scoped = prefix === "codex" || prefix === "api";
	const wanted = scoped ? rest.join(":") : spec;
	if (!wanted) return null;
	const candidates = orderedFailoverConnections(connections).filter((row) =>
		prefix === "codex"
			? row.kind === "subscription"
			: prefix === "api"
				? row.kind !== "subscription"
				: true,
	);
	for (const connection of candidates) {
		const model =
			connection.models.find((row) => row.id === wanted) ??
			connection.models.find((row) => servesModel(connection, row, wanted));
		if (model) return { connection, model };
	}
	return null;
}

/**
 * Which route serves a role's children, checked against the routes this user
 * can use now (the plan only when they are signed in to ChatGPT). An unusable
 * entry never fails the spawn: the child runs on the parent's model and the
 * notice says why.
 */
export function resolveRoleModel(input: {
	readonly role: ModelRole;
	readonly roleModels: RoleModels | undefined;
	readonly connections: readonly FailoverConnection[];
	/** The parent's model, named in the fallback notice. */
	readonly parentModel: string;
	/** The parent turn's reasoning effort: used when the entry sets none and the route offers it. */
	readonly parentEffort?: string;
}): RoleModelResolution {
	const entry = roleModelFor(input.roleModels, input.role);
	if (!entry) return { kind: "inherit" };
	const found = findRoute(entry.model, input.connections);
	if (!found) {
		const offered = input.connections
			.flatMap((connection) =>
				connection.models.map((model) =>
					connection.kind === "subscription"
						? `codex:${model.id}`
						: `api:${canonicalModelId(connection, model.id) ?? model.id}`,
				),
			)
			.filter((value, index, all) => all.indexOf(value) === index);
		return {
			kind: "fallback",
			notice: `roleModels.${input.role} "${entry.model}" is not available to this account${
				entry.model.startsWith("codex:") &&
				!input.connections.some((row) => row.kind === "subscription")
					? " (no Codex sign-in)"
					: ""
			}; this ${input.role} runs on the parent's model ${input.parentModel}. Available: ${offered.slice(0, 12).join(", ") || "none"}${offered.length > 12 ? ", …" : ""}.`,
		};
	}
	const model = routeOf(found.connection, found.model);
	if (!entry.effort)
		return {
			kind: "role",
			model:
				input.parentEffort &&
				found.model.reasoning?.includes(input.parentEffort)
					? { ...model, reasoning: input.parentEffort }
					: model,
		};
	if (!found.model.reasoning?.includes(entry.effort))
		return {
			kind: "role",
			model,
			notice: `roleModels.${input.role} effort "${entry.effort}" is not offered by ${model.label} (offered: ${found.model.reasoning?.join(", ") || "none"}); using its default.`,
		};
	return { kind: "role", model: { ...model, reasoning: entry.effort } };
}
