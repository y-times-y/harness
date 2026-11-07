import type { ApiModelSpeedId } from "./api-model-list";

/** What an API-key turn asked for beyond its model; absent fields use the model's defaults. */
export type ApiTurnSettings = {
	readonly reasoning?: string;
	readonly speed?: ApiModelSpeedId;
	/** The route's alternate context window (context-window-option.ts); absent is the standard one. */
	readonly alternateContext?: true;
};

/** Stored settings, keeping only values a turn can use. */
export function apiTurnSettings(value: unknown): ApiTurnSettings {
	if (!value || typeof value !== "object") return {};
	const { reasoning, speed, alternateContext } = value as Record<
		string,
		unknown
	>;
	return {
		...(typeof reasoning === "string" && reasoning ? { reasoning } : {}),
		...(speed === "fast" || speed === "ultrafast" ? { speed } : {}),
		...(alternateContext === true ? { alternateContext } : {}),
	};
}
