import { listedOpenRouterId } from "../../domain/api-model-list";
import type { ModelProvider } from "../../domain/model-connection";
import { knownModelLimits } from "../../domain/model-context-windows";
import { UNKNOWN_CONTEXT_WINDOW } from "../services/api-agent-context";
import { browseModels } from "./browse-models";
import { readModelCatalogBody } from "./model-catalog";

type ModelContext = {
	contextWindow?: number;
	/** False when the public catalog lists the model without image input. */
	imageInput?: boolean;
	nativeCompaction?: "openai" | "openai-endpoint" | "anthropic" | "xai";
};
const cached = new Map<string, { expires: number; value: ModelContext }>();
const positiveInteger = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0
		? value
		: undefined;

/** Public catalog limits or owner-authenticated metadata only; never starts inference. */
export async function readModelContext(
	input: {
		provider: ModelProvider;
		baseUrl: string;
		apiKey: string;
		modelId: string;
		contextWindow?: number;
		cacheKey: string;
	},
	fetch: typeof globalThis.fetch,
): Promise<ModelContext> {
	const saved = cached.get(input.cacheKey);
	if (saved && saved.expires > Date.now()) return saved.value;
	let contextWindow = input.contextWindow;
	const known = knownModelLimits(input.modelId);
	const origin = new URL(input.baseUrl).origin;
	let nativeCompaction: ModelContext["nativeCompaction"] =
		input.provider === "openai" &&
		origin === "https://api.openai.com" &&
		/^gpt-6(?:[.-]|$)/.test(input.modelId)
			? "openai"
			: undefined;
	if (
		input.provider === "openai" &&
		origin === "https://api.openai.com" &&
		/^gpt-5\.[2-6](?:[.-]|$)/.test(input.modelId)
	)
		nativeCompaction = "openai-endpoint";
	if (
		input.provider === "compatible" &&
		origin === "https://api.x.ai" &&
		/^grok-4\.7(?:-|$)/.test(input.modelId)
	)
		nativeCompaction = "xai";
	try {
		if (
			(input.provider === "google" &&
				origin === "https://generativelanguage.googleapis.com") ||
			(input.provider === "anthropic" && origin === "https://api.anthropic.com")
		) {
			const response = await fetch(
				`${input.baseUrl}/models/${encodeURIComponent(input.modelId)}`,
				{
					headers:
						input.provider === "google"
							? { "x-goog-api-key": input.apiKey }
							: {
									"x-api-key": input.apiKey,
									"anthropic-version": "2023-06-01",
									"anthropic-beta": "compact-2026-09-04",
								},
					signal: AbortSignal.timeout(3000),
					redirect: "manual",
				},
			);
			if (response.ok) {
				const row = await readModelCatalogBody(response);
				contextWindow =
					positiveInteger(row.inputTokenLimit ?? row.max_input_tokens) ??
					contextWindow;
				if (
					input.provider === "anthropic" &&
					row.capabilities?.compaction?.supported === true
				)
					nativeCompaction = "anthropic";
			}
		} else if (
			input.provider === "openrouter" ||
			input.provider === "openai" ||
			origin === "https://openrouter.ai"
		) {
			const catalogId =
				input.provider === "openai" && origin !== "https://openrouter.ai"
					? `openai/${input.modelId}`
					: input.modelId;
			// A routed model's window is checked in (model-context-windows.ts):
			// no third-party catalog request, and no guess when it is down.
			contextWindow ??=
				known?.contextWindow ??
				(await openRouterContextWindow(
					catalogId,
					origin === "https://openrouter.ai" ? fetch : undefined,
				));
		} else if (contextWindow === undefined && input.provider === "compatible")
			contextWindow = await listedContextWindow(input, fetch);
	} catch (error) {
		// An unreachable or malformed metadata endpoint: a routed model falls
		// back to its checked-in window below; any other model stays unknown.
		console.warn("Model context metadata unavailable.", {
			provider: input.provider,
			modelId: input.modelId,
			error: error instanceof Error ? error.name : "unknown",
		});
	}
	contextWindow ??= known?.contextWindow;
	if (contextWindow === undefined)
		console.warn(
			"Model context window unknown; the run uses the unknown-window budget.",
			{
				provider: input.provider,
				modelId: input.modelId,
				assumedWindow: UNKNOWN_CONTEXT_WINDOW,
			},
		);
	const imageInput =
		known?.imageInput ??
		(await catalogImageInput(input).catch(() => undefined));
	const value = {
		contextWindow,
		nativeCompaction,
		...(imageInput === undefined ? {} : { imageInput }),
	};
	if (cached.size >= 1000) cached.delete(cached.keys().next().value as string);
	cached.set(input.cacheKey, {
		value,
		expires: Date.now() + (contextWindow ? 15 * 60_000 : 30_000),
	});
	return value;
}

const CONTEXT_FIELDS = [
	"context_length",
	"context_window",
	"max_context_length",
	"max_model_len",
	"inputTokenLimit",
	"max_input_tokens",
] as const;

function rowContextWindow(row: unknown): number | undefined {
	if (!row || typeof row !== "object") return undefined;
	for (const field of CONTEXT_FIELDS) {
		const value = positiveInteger((row as Record<string, unknown>)[field]);
		if (value) return value;
	}
	return undefined;
}

/**
 * The public catalog lists most routes; unlisted variants (free tiers, newly
 * added or key-scoped models) still report per-endpoint limits publicly.
 */
async function openRouterContextWindow(
	modelId: string,
	fetch: typeof globalThis.fetch | undefined,
): Promise<number | undefined> {
	const listed = await browseModels().catch(() => []);
	const row = listed.find((model) => model.id === modelId);
	if (row?.contextWindow) return row.contextWindow;
	if (!fetch || !/^[\w.-]+\/[\w.:-]+$/.test(modelId)) return undefined;
	const response = await fetch(
		`https://openrouter.ai/api/v1/models/${modelId}/endpoints`,
		{ signal: AbortSignal.timeout(3000), redirect: "manual" },
	);
	if (!response.ok) return undefined;
	const body = await readModelCatalogBody(response);
	const limits = (
		Array.isArray(body?.data?.endpoints) ? body.data.endpoints : []
	).flatMap((endpoint: unknown) => rowContextWindow(endpoint) ?? []);
	return limits.length
		? Math.max(...limits)
		: (rowContextWindow(body?.data) ?? undefined);
}

/** The same owner-authenticated listing connection discovery already reads. */
async function listedContextWindow(
	input: { baseUrl: string; apiKey: string; modelId: string },
	fetch: typeof globalThis.fetch,
): Promise<number | undefined> {
	const response = await fetch(`${input.baseUrl}/models`, {
		headers: { Authorization: `Bearer ${input.apiKey}` },
		signal: AbortSignal.timeout(3000),
		redirect: "manual",
	});
	if (!response.ok) return undefined;
	const body = await readModelCatalogBody(response);
	const rows: unknown[] = Array.isArray(body?.data)
		? body.data
		: Array.isArray(body?.models)
			? body.models
			: [];
	return rowContextWindow(
		rows.find(
			(row) =>
				!!row &&
				typeof row === "object" &&
				((row as { id?: unknown }).id === input.modelId ||
					(row as { name?: unknown }).name === input.modelId),
		),
	);
}

/** Whether the public catalog lists image input for the model; unknown stays undefined. */
async function catalogImageInput(input: {
	provider: ModelProvider;
	modelId: string;
}): Promise<boolean | undefined> {
	const catalogId =
		listedOpenRouterId(input.modelId) ??
		(input.provider === "openai" ? `openai/${input.modelId}` : input.modelId);
	const listed = await browseModels();
	return listed.find((model) => model.id === catalogId)?.imageInput;
}
