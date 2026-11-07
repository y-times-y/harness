import {
	type ApiModelSpeedId,
	openRouterRouting,
} from "../../domain/api-model-list";
import { isDevelopmentEnvironment } from "../../domain/development-environment";

/**
 * Development only: `YTIMESY_DEV_ALLOW_ANY_MODEL=1` offers every model a
 * connection lists, so the harness can be smoke-tested on free models. Only
 * in development (see isDevelopmentEnvironment), whatever the variable says.
 */
export function devAllowsAnyModel(
	env: {
		readonly YTIMESY_DEV_ALLOW_ANY_MODEL?: string;
		readonly YTIMESY_ENVIRONMENT?: string;
	} = process.env,
): boolean {
	return (
		env.YTIMESY_DEV_ALLOW_ANY_MODEL === "1" && isDevelopmentEnvironment(env)
	);
}

/** OpenRouter's $0 variant of a model (`maker/model:free`). */
export function isFreeOpenRouterModel(modelId: string): boolean {
	return /^[\w.-]+\/[\w.-]+:free$/.test(modelId);
}

/**
 * Pins every OpenRouter request to the model maker's own providers (or, for a
 * listed open-weight model, its approved hosts) with fallbacks off: if those
 * are unavailable the request fails instead of moving to another host. A
 * faster `speed` pins the maker's own tiered endpoints instead, and is refused
 * when the model has none. In development with the any-model flag, an
 * unlisted `:free` variant passes through unpinned (its free hosts are not a
 * maker's own); paid unlisted models stay refused.
 */
export function openRouterOfficialFetch(
	fetch: typeof globalThis.fetch,
	speed?: ApiModelSpeedId,
	/** The local runner: the caller's own key may use any model, with OpenRouter's own routing. */
	anyModel = false,
): typeof globalThis.fetch {
	if (anyModel) return fetch;
	return async (url, init) => {
		if (typeof init?.body !== "string") return fetch(url, init);
		const body = JSON.parse(init.body) as Record<string, unknown>;
		if (typeof body.model !== "string") return fetch(url, init);
		const routing = openRouterRouting(body.model, speed);
		if (
			!routing &&
			!speed &&
			isFreeOpenRouterModel(body.model) &&
			devAllowsAnyModel()
		)
			return fetch(url, init);
		if (!routing)
			throw new Error(
				speed
					? `${body.model} has no ${speed} endpoint from its maker.`
					: `${body.model} is not an offered model; OpenRouter requests are limited to listed models.`,
			);
		const provider =
			body.provider && typeof body.provider === "object" ? body.provider : {};
		return fetch(url, {
			...init,
			body: JSON.stringify({
				...body,
				provider: {
					...provider,
					only: routing.only,
					allow_fallbacks: false,
					...(routing.zdr ? { zdr: true } : {}),
				},
			}),
		});
	};
}
