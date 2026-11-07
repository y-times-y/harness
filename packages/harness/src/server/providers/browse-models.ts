import {
	type BrowseModel,
	parseBrowseModels,
} from "../../domain/browse-models";
import { readModelCatalogBody } from "./model-catalog";
import { modelEndpointTransport } from "./model-endpoint";

let cached: { models: BrowseModel[]; expires: number } | undefined;

/** Public metadata only; never forwards account credentials or starts inference. */
export function browseModels(): Promise<BrowseModel[]> {
	if (cached && cached.expires > Date.now())
		return Promise.resolve(cached.models);
	return (async () => {
		const transport = modelEndpointTransport("https://openrouter.ai/api/v1");
		try {
			const response = await transport.fetch(
				"https://openrouter.ai/api/v1/models?sort=top-weekly",
				{
					signal: AbortSignal.timeout(8000),
					redirect: "manual",
				},
			);
			if (!response.ok) throw new Error("Model catalog unavailable.");
			const models = parseBrowseModels(await readModelCatalogBody(response));
			if (!models.length) throw new Error("Model catalog unavailable.");
			cached = { models, expires: Date.now() + 15 * 60_000 };
			return models;
		} finally {
			await transport.close();
		}
	})().catch((error) => {
		if (cached) return cached.models;
		throw error;
	});
}
