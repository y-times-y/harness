import { expect, it } from "vitest";
import { API_MODEL_LIST } from "./api-model-list";
import { knownModelLimits } from "./model-context-windows";

it("knows every listed model's window by each of its ids", () => {
	for (const model of API_MODEL_LIST) {
		expect(knownModelLimits(model.openRouterId)).toBeDefined();
		if (model.directId)
			expect(knownModelLimits(model.directId)).toEqual(
				knownModelLimits(model.openRouterId),
			);
	}
});

it("reads Bedrock, route and suffixed ids, and never guesses an unlisted variant", () => {
	expect(knownModelLimits("global.openai.gpt-6-astra")?.contextWindow).toBe(
		1_050_000,
	);
	expect(knownModelLimits("openai.gpt-6.1-sol")?.contextWindow).toBe(1_050_000);
	expect(
		knownModelLimits("global.anthropic.claude-haiku-5-5")?.contextWindow,
	).toBe(1_000_000);
	expect(knownModelLimits("openai/gpt-6-luna:batch")?.contextWindow).toBe(
		1_050_000,
	);
	expect(knownModelLimits("gpt-6-astra-pro")).toBeUndefined();
	expect(knownModelLimits("gpt-6-fixture")).toBeUndefined();
	expect(knownModelLimits("toString")).toBeUndefined();
});
