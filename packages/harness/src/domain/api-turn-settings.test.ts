import { expect, it } from "vitest";
import { apiTurnSettings } from "./api-turn-settings";

it("keeps only settings a turn can use", () => {
	expect(apiTurnSettings({ reasoning: "high", speed: "fast" })).toEqual({
		reasoning: "high",
		speed: "fast",
	});
	expect(apiTurnSettings({ reasoning: "", speed: "turbo" })).toEqual({});
	expect(apiTurnSettings(null)).toEqual({});
});

it("keeps the larger context window only when it was chosen", () => {
	expect(apiTurnSettings({ alternateContext: true })).toEqual({
		alternateContext: true,
	});
	expect(apiTurnSettings({ alternateContext: "yes" })).toEqual({});
	expect(apiTurnSettings({ alternateContext: false })).toEqual({});
});
