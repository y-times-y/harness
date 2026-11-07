import { API_MODEL_LIST } from "./api-model-list";
import {
	claudeCodeModelLabel,
	parseClaudeCodeRouteId,
} from "./claude-code-route";
import type { ListedContextWindow } from "./context-window-option";
import { parseModelRouteId } from "./model-connection";

export type ListedReasoning = {
	readonly levels: readonly [
		{ readonly id: string; readonly label: string },
		...{ readonly id: string; readonly label: string }[],
	];
	readonly defaultLevelId: string;
};

/** A faster speed than standard, with its price relative to standard when known. */
export type ListedSpeed = {
	readonly id: "fast" | "ultrafast";
	readonly priceMultiple?: number;
};

export type ListedModel = {
	readonly id: string;
	readonly label: string;
	readonly notice?: string;
	readonly supportsFastMode?: boolean;
	readonly speeds?: readonly ListedSpeed[];
	readonly fastModeId?: string;
	readonly reasoning?: ListedReasoning;
	/** A second context window the route offers; absent when it has none. */
	readonly contextWindow?: ListedContextWindow;
};

export function listedModelSupportsFastMode(row: {
	readonly supportsFastMode?: unknown;
	readonly fast?: unknown;
	readonly variants?: unknown;
	readonly serviceTiers?: unknown;
	readonly additionalSpeedTiers?: unknown;
	readonly capabilities?: unknown;
}): boolean {
	if (row.supportsFastMode === true || row.fast === true) return true;
	const capabilities = asRecord(row.capabilities);
	if (capabilities?.fast === true || capabilities?.supportsFastMode === true) {
		return true;
	}
	return listedFastModeId(row) != null;
}

export function listedFastModeId(row: {
	readonly fastModeId?: unknown;
	readonly variants?: unknown;
	readonly serviceTiers?: unknown;
	readonly additionalSpeedTiers?: unknown;
	readonly capabilities?: unknown;
}): string | undefined {
	if (typeof row.fastModeId === "string" && row.fastModeId.trim()) {
		return row.fastModeId.trim();
	}
	if (listedVariantIds(row.variants).includes("fast")) return "fast";
	const capabilities = asRecord(row.capabilities);
	if (listedVariantIds(capabilities?.variants).includes("fast")) return "fast";
	return (
		listedFastServiceTierId(row.serviceTiers) ??
		listedFastServiceTierId(row.additionalSpeedTiers) ??
		listedFastServiceTierId(capabilities?.serviceTiers) ??
		listedFastServiceTierId(capabilities?.additionalSpeedTiers)
	);
}

export function listedReasoningFromRow(row: {
	readonly reasoning?: unknown;
	readonly variants?: unknown;
	readonly supportedReasoningEfforts?: unknown;
	readonly defaultReasoningEffort?: unknown;
	readonly capabilities?: unknown;
}): ListedReasoning | undefined {
	const persisted = listedReasoningFromPersisted(row.reasoning);
	if (persisted) return persisted;
	const capabilities = asRecord(row.capabilities);
	return (
		listedReasoningFromVariants(row.variants) ??
		listedReasoningFromVariants(capabilities?.variants) ??
		listedReasoningFromEfforts(
			row.supportedReasoningEfforts ?? capabilities?.supportedReasoningEfforts,
			row.defaultReasoningEffort ?? capabilities?.defaultReasoningEffort,
		)
	);
}

export function listedReasoningFromVariants(
	variants: unknown,
): ListedReasoning | undefined {
	const ids = listedVariantIds(variants).filter((id) => id !== "fast");
	if (ids.length === 0) return undefined;
	const levels = ids.map((id) => ({ id, label: id }));
	const defaultLevelId = ids.includes("medium") ? "medium" : ids[0];
	return {
		levels: [levels[0], ...levels.slice(1)],
		defaultLevelId,
	};
}

function listedVariantIds(variants: unknown): readonly string[] {
	if (Array.isArray(variants)) {
		return variants.filter(
			(value): value is string =>
				typeof value === "string" && value.trim().length > 0,
		);
	}
	if (typeof variants === "object" && variants !== null) {
		return Object.keys(variants).filter((key) => key.trim().length > 0);
	}
	return [];
}

function listedReasoningFromPersisted(
	value: unknown,
): ListedReasoning | undefined {
	if (!isRecord(value)) return undefined;
	const levels = listedEffortLevels(value.levels);
	if (!levels) return undefined;
	const defaultLevelId =
		typeof value.defaultLevelId === "string" &&
		levels.some((level) => level.id === value.defaultLevelId)
			? value.defaultLevelId
			: levels[0].id;
	return { levels, defaultLevelId };
}

function listedReasoningFromEfforts(
	efforts: unknown,
	defaultEffort: unknown,
): ListedReasoning | undefined {
	const levels = listedEffortLevels(efforts);
	if (!levels) return undefined;
	const requested =
		typeof defaultEffort === "string" ? defaultEffort.trim() : "";
	const defaultLevelId = levels.some((level) => level.id === requested)
		? requested
		: levels.some((level) => level.id === "medium")
			? "medium"
			: levels[0].id;
	return { levels, defaultLevelId };
}

function listedEffortLevels(
	value: unknown,
): ListedReasoning["levels"] | undefined {
	if (!Array.isArray(value)) return undefined;
	const levels: { id: string; label: string }[] = [];
	for (const item of value) {
		if (typeof item === "string" && item.trim() && item.trim() !== "fast") {
			levels.push({ id: item.trim(), label: item.trim() });
			continue;
		}
		if (!isRecord(item)) continue;
		const id =
			readListedString(item.reasoningEffort) ??
			readListedString(item.id) ??
			readListedString(item.effort);
		if (!id || id === "fast") continue;
		levels.push({
			id,
			label:
				readListedString(item.description) ??
				readListedString(item.label) ??
				id,
		});
	}
	if (levels.length === 0) return undefined;
	return [levels[0], ...levels.slice(1)];
}

function listedFastServiceTierId(value: unknown): string | undefined {
	if (typeof value === "string" && value.trim().toLowerCase() === "fast") {
		return value.trim();
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			const id = listedFastServiceTierId(item);
			if (id) return id;
		}
		return undefined;
	}
	if (!isRecord(value)) return undefined;
	for (const key of [value.id, value.name]) {
		if (typeof key === "string" && key.trim().toLowerCase() === "fast") {
			return typeof value.id === "string" && value.id.trim()
				? value.id.trim()
				: key.trim();
		}
	}
	return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function readListedString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type ListedModelPreference = {
	readonly lastUsedId?: string;
	readonly excludedIds?: readonly string[];
};

type ListedModelSessionHint = {
	readonly harness: string;
	readonly listedModelId: string | null;
	readonly items: unknown;
};

export function listedModelRestrictedByProvider(message: string): boolean {
	return /\[user_blocked\]|access has been restricted due to repeated policy/i.test(
		message,
	);
}

export function sessionListedModelIsBlocked(
	listedModelId: string | null | undefined,
	items: unknown,
): boolean {
	const id = listedModelId?.trim();
	if (!id) return false;
	const rows = Array.isArray(items) ? items : [];
	for (let index = rows.length - 1; index >= 0; index -= 1) {
		const item = rows[index];
		if (!item || typeof item !== "object") continue;
		const record = item as {
			kind?: unknown;
			message?: unknown;
			text?: unknown;
		};
		if (
			record.kind === "error" &&
			typeof record.message === "string" &&
			listedModelRestrictedByProvider(record.message)
		) {
			return true;
		}
		if (record.kind === "agentMessage" && typeof record.text === "string") {
			if (listedModelRestrictedByProvider(record.text)) return true;
			if (record.text.trim()) return false;
		}
	}
	return false;
}

export function listedModelPreferenceFromSessions(input: {
	readonly harness: string;
	readonly sessions: readonly ListedModelSessionHint[];
}): {
	readonly listedModelId: string;
	readonly blockedListedModelIds: readonly string[];
} {
	const own = input.sessions.filter(
		(session) => session.harness === input.harness,
	);
	const blockedListedModelIds = [
		...new Set(
			own.flatMap((session) => {
				const id = session.listedModelId?.trim();
				if (!id) return [];
				return sessionListedModelIsBlocked(id, session.items) ? [id] : [];
			}),
		),
	];
	const listedModelId =
		own
			.map((session) => session.listedModelId?.trim() ?? "")
			.find((id) => id && !blockedListedModelIds.includes(id)) ?? "";
	return { listedModelId, blockedListedModelIds };
}

/**
 * A listed id's name when its route is not listed (a refused subscription, a
 * removed key): a model ytimesy offers keeps its label, anything else shows
 * its catalog id tail.
 */
export function listedModelDisplayName(modelId: string) {
	const id = modelId.trim();
	if (!id) return "";
	const claudeCode = parseClaudeCodeRouteId(id);
	if (claudeCode) return claudeCodeModelLabel(claudeCode);
	const routed = parseModelRouteId(id)?.modelId ?? id;
	const offered = API_MODEL_LIST.find(
		(model) => model.openRouterId === routed || model.directId === routed,
	);
	if (offered) return offered.label;
	const slash = routed.lastIndexOf("/");
	return slash >= 0 ? routed.slice(slash + 1) : routed;
}

export function preferredListedModelId(
	models: readonly { readonly id: string }[],
	options?: ListedModelPreference,
): string {
	const excluded = new Set(options?.excludedIds ?? []);
	const listed = models.filter((model) => model.id && !excluded.has(model.id));
	const lastUsed = options?.lastUsedId?.trim();
	if (lastUsed && !excluded.has(lastUsed)) {
		if (listed.length === 0 || listed.some((model) => model.id === lastUsed)) {
			return lastUsed;
		}
	}
	return (
		listed.find((model) => model.id === "gpt-5.3-codex-spark")?.id ??
		listed.find(
			(model) =>
				model.id.startsWith("opencode/") && model.id.includes("muse-spark-1.3"),
		)?.id ??
		listed.find(
			(model) => model.id.startsWith("opencode/") && model.id.includes("spark"),
		)?.id ??
		listed.find(
			(model) =>
				model.id.startsWith("opencode/") &&
				(model.id.endsWith("-free") || model.id.includes("contributor-free")),
		)?.id ??
		listed[0]?.id ??
		""
	);
}

export function submittedListedModelId(
	requested: string,
	models: readonly { readonly id: string }[],
	options?: ListedModelPreference,
): string {
	const trimmed = requested.trim();
	const excluded = new Set(options?.excludedIds ?? []);
	if (
		trimmed &&
		!excluded.has(trimmed) &&
		models.some((model) => model.id === trimmed)
	) {
		return trimmed;
	}
	return preferredListedModelId(models, options);
}

export function composerModelIdForCatalog(input: {
	readonly requestedId: string;
	readonly catalog: readonly { readonly id: string }[];
	readonly lastUsedForCatalog?: string;
	readonly excludedIds?: readonly string[];
}): string {
	const excluded = new Set(input.excludedIds ?? []);
	const listed = input.catalog.filter(
		(model) => model.id && !excluded.has(model.id),
	);
	const requested = input.requestedId.trim();
	if (requested && listed.some((model) => model.id === requested)) {
		return requested;
	}
	const remembered = input.lastUsedForCatalog?.trim() ?? "";
	if (remembered && listed.some((model) => model.id === remembered)) {
		return remembered;
	}
	if (listed.length === 0) return "";
	return preferredListedModelId(listed, { excludedIds: input.excludedIds });
}
