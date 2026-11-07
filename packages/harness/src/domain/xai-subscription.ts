import { API_MODEL_LIST } from "./api-model-list";
import { DIRECT_MODEL_ENDPOINTS } from "./browse-models";
import type { ConnectedModel } from "./model-connection";

/**
 * A user's xAI SuperGrok (or X Premium) subscription, signed in with xAI's
 * device-code OAuth, used as a model connection: chats run on Grok through
 * api.x.ai with the user's own bearer token and draw from their plan.
 * Off unless YTIMESY_XAI_SUBSCRIPTION_ENABLED=1; when off nothing shows.
 */
export function xaiSubscriptionEnabled(
	env: { readonly YTIMESY_XAI_SUBSCRIPTION_ENABLED?: string } = process.env,
): boolean {
	return env.YTIMESY_XAI_SUBSCRIPTION_ENABLED === "1";
}

/** How the chat and the picker name the subscription's connection. */
export const XAI_SUBSCRIPTION_LABEL = "Grok plan";

/** The xAI API the subscription's token calls; already an official edge endpoint. */
export const XAI_API_BASE_URL = DIRECT_MODEL_ENDPOINTS["x-ai"] as string;

/** Where the connection stands: usable, or waiting for the user. */
export type XaiSubscriptionStatus = "ready" | "reconnect" | "not-eligible";

/** What Settings and the first run show. */
export type XaiSubscriptionView =
	| { readonly status: "disconnected" }
	| {
			readonly status: XaiSubscriptionStatus;
			readonly connectionId: string;
			readonly modelCount: number;
	  };

export function xaiSubscriptionMessage(
	status: Exclude<XaiSubscriptionStatus, "ready">,
): string {
	return status === "reconnect"
		? "Your Grok sign-in expired. Reconnect it in Settings > Agents."
		: "Your xAI plan can't use Grok here. Check your SuperGrok or X subscription, then reconnect.";
}

/**
 * The catalog's Grok models, as the xAI API names them: what the connection
 * offers when xAI's model list is unavailable to the subscription's token.
 */
export function catalogXaiModels(): ConnectedModel[] {
	return API_MODEL_LIST.flatMap((entry) =>
		entry.author === "x-ai" && entry.directId
			? [
					{
						id: entry.directId,
						label: entry.label,
						toolStreamingVerified: false,
					},
				]
			: [],
	);
}

/**
 * The models the subscription offers: xAI's own list when it names any
 * catalog Grok model, else the catalog's Grok models.
 */
export function xaiSubscriptionModels(
	discovered: readonly ConnectedModel[] | null,
): ConnectedModel[] {
	const catalog = catalogXaiModels();
	const listed = new Set(catalog.map((model) => model.id));
	return discovered?.some((model) => listed.has(model.id))
		? [...discovered]
		: catalog;
}
