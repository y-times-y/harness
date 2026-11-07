import type {
	ConnectedModel,
	ModelProvider,
} from "../../domain/model-connection";

/** What a key can access; API_MODEL_LIST alone decides what is offered from it. */
export function parseConnectedModels(
	provider: ModelProvider,
	value: unknown,
): ConnectedModel[] {
	const data = value as { data?: unknown; models?: unknown };
	const rows = provider === "google" ? data?.models : data?.data;
	if (!Array.isArray(rows))
		throw new Error("Provider did not return a model catalog.");
	const models = new Map<string, ConnectedModel>();
	for (const row of rows) {
		if (!row || typeof row !== "object") continue;
		if (
			provider === "google" &&
			(!Array.isArray(row.supportedGenerationMethods) ||
				!row.supportedGenerationMethods.includes("generateContent"))
		)
			continue;
		const id =
			provider === "google"
				? typeof row.name === "string"
					? row.name.replace(/^models\//, "")
					: undefined
				: row.id;
		if (typeof id !== "string" || !id.trim() || id.length > 512) continue;
		const label = row.displayName ?? row.display_name ?? row.name ?? id;
		models.set(id, {
			id,
			label: typeof label === "string" ? label.slice(0, 160) : id,
			toolStreamingVerified: false,
			...(Number.isSafeInteger(
				row.inputTokenLimit ?? row.max_input_tokens ?? row.context_length,
			) &&
			(row.inputTokenLimit ?? row.max_input_tokens ?? row.context_length) > 0
				? {
						contextWindow:
							row.inputTokenLimit ?? row.max_input_tokens ?? row.context_length,
					}
				: {}),
		});
	}
	return [...models.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export async function discoverConnectionModels(
	input: { provider: ModelProvider; baseUrl: string; apiKey: string },
	fetch: typeof globalThis.fetch,
): Promise<ConnectedModel[]> {
	const headers: Record<string, string> =
		input.provider === "anthropic"
			? { "x-api-key": input.apiKey, "anthropic-version": "2023-06-01" }
			: input.provider === "google"
				? { "x-goog-api-key": input.apiKey }
				: { Authorization: `Bearer ${input.apiKey}` };
	const models = new Map<string, ConnectedModel>();
	let cursor: string | undefined;
	for (let page = 0; page < 20; page++) {
		const url = new URL(`${input.baseUrl}/models`);
		if (cursor)
			url.searchParams.set(
				input.provider === "google" ? "pageToken" : "after_id",
				cursor,
			);
		const response = await fetch(url, {
			headers,
			signal: AbortSignal.timeout(15_000),
		});
		if (!response.ok)
			throw new Error(
				`Model listing failed (HTTP ${response.status}). Check the key and endpoint.`,
			);
		const body = await readModelCatalogBody(response);
		for (const model of parseConnectedModels(input.provider, body))
			models.set(model.id, model);
		const next =
			input.provider === "google"
				? body.nextPageToken
				: input.provider === "anthropic" && body.has_more
					? body.last_id
					: undefined;
		if (!next) return [...models.values()];
		if (typeof next !== "string" || next === cursor)
			throw new Error("Invalid model catalog pagination.");
		cursor = next;
	}
	throw new Error("Model catalog exceeded pagination limit.");
}

export async function readModelCatalogBody(response: Response) {
	if (!response.body) throw new Error("Empty model catalog.");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > 4_000_000) throw new Error("Model catalog is too large.");
			chunks.push(value);
		}
	} finally {
		await reader.cancel();
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
