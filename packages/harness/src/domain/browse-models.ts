import type { ModelProvider } from "./model-connection";

export type BrowseModel = {
	id: string;
	label: string;
	author: string;
	created: number;
	contextWindow?: number;
	/** The catalog lists its input modalities; false when images are not among them. */
	imageInput?: boolean;
};
export const AUTHOR_LABELS: Record<string, string> = {
	anthropic: "Anthropic",
	openai: "OpenAI",
	"x-ai": "xAI",
	google: "Google",
	meta: "Meta",
	moonshotai: "Moonshot AI",
	deepseek: "DeepSeek",
	qwen: "Qwen",
	mistralai: "Mistral",
	"z-ai": "Z.ai",
	tencent: "Tencent",
	custom: "Custom",
};
const RETAINED_MODEL_GENERATIONS = 3;

function modelGeneration(id: string) {
	const canonical = id.replace(/:.*$/, "");
	const version = canonical.match(/\d+(?:[.-]\d{1,2}(?!\d))?/);
	if (!version || Number(version[0].split(/[.-]/)[0]) >= 2000) return null;
	const family = canonical.slice(0, version.index).replace(/[-.]$/, "");
	const claudeTier = canonical.match(
		/(?:^|[-/])(opus|sonnet|haiku)(?:-|$)/,
	)?.[1];
	return {
		family: claudeTier ? `anthropic/claude-${claudeTier}` : family,
		version: version[0].replace("-", "."),
	};
}

/** Keep release generations, not three individual variants or recently republished aliases. */
export function recentModelGenerations<T extends { id: string }>(
	models: readonly T[],
): T[] {
	const generations = new Map<string, Set<string>>();
	for (const model of models) {
		const release = modelGeneration(model.id);
		if (!release) continue;
		const versions = generations.get(release.family) ?? new Set<string>();
		versions.add(release.version);
		generations.set(release.family, versions);
	}
	const retained = new Map(
		[...generations].map(([family, versions]) => [
			family,
			[...versions]
				.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
				.slice(0, RETAINED_MODEL_GENERATIONS),
		]),
	);
	return models.filter((model) => {
		const release = modelGeneration(model.id);
		return !release || retained.get(release.family)?.includes(release.version);
	});
}
export function matchesModelSearch(
	model: Pick<BrowseModel, "label" | "author">,
	search: string,
): boolean {
	const term = search.trim().toLowerCase();
	return (
		!term ||
		model.label.toLowerCase().includes(term) ||
		model.author.toLowerCase().includes(term) ||
		(AUTHOR_LABELS[model.author] ?? "").toLowerCase().includes(term)
	);
}
export function visibleModelChoices<
	T extends Pick<BrowseModel, "label" | "author">,
>(models: readonly T[], search: string): T[] {
	const matching = models.filter((model) => matchesModelSearch(model, search));
	return matching;
}
export const DIRECT_MODEL_ENDPOINTS: Record<string, string> = {
	meta: "https://api.meta.ai/v1",
	deepseek: "https://api.deepseek.com",
	"x-ai": "https://api.x.ai/v1",
	mistralai: "https://api.mistral.ai/v1",
};
export function directModelProvider(author: string): ModelProvider | null {
	if (Object.hasOwn(DIRECT_MODEL_ENDPOINTS, author)) return "compatible";
	return author === "openai" || author === "anthropic" || author === "google"
		? author
		: null;
}
/** OpenRouter's public catalog: confirms a listed model exists and gives its context size. */
export function parseBrowseModels(value: unknown): BrowseModel[] {
	const rows = (value as { data?: unknown })?.data;
	if (!Array.isArray(rows)) throw new Error("Model catalog unavailable.");
	const models = new Map<string, BrowseModel>();
	for (const row of rows) {
		if (!row || typeof row !== "object") continue;
		const model = row as Record<string, unknown>;
		if (typeof model.id !== "string" || model.id.length > 512) continue;
		models.set(model.id, {
			id: model.id,
			label:
				typeof model.name === "string" ? model.name.slice(0, 160) : model.id,
			author: model.id.split("/")[0] ?? "",
			created: typeof model.created === "number" ? model.created : 0,
			...(typeof model.context_length === "number" &&
			Number.isSafeInteger(model.context_length) &&
			model.context_length > 0
				? { contextWindow: model.context_length }
				: {}),
			...imageInputField(model.architecture),
		});
	}
	return [...models.values()];
}

function imageInputField(architecture: unknown): { imageInput?: boolean } {
	const modalities = (architecture as { input_modalities?: unknown } | null)
		?.input_modalities;
	return Array.isArray(modalities)
		? { imageInput: modalities.includes("image") }
		: {};
}
