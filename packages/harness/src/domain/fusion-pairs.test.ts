import { describe, expect, it } from "vitest";
import { fusionPairFor, fusionPairProfile, modelName } from "./fusion-pairs";

describe("fusion pair profiles", () => {
	it("names a model without its route or effort", () => {
		expect(modelName("codex:gpt-6-luna@low")).toBe("gpt-6-luna");
		expect(modelName("api/c1/google%2Fgemini-3.8-flash")).toBe(
			"google%2fgemini-3.8-flash",
		);
		expect(modelName("gpt-6.1-sol")).toBe("gpt-6.1-sol");
	});

	it("tunes Sol leading Luna: prescriptive briefs, no pushback, the sidekick explores", () => {
		expect(fusionPairProfile("gpt-6.1-sol", "codex:gpt-6-luna")).toEqual({
			name: "sol+luna",
			briefStyle: "prescriptive",
			pushback: false,
			sidekickExplores: true,
		});
	});

	it("gives unknown pairs outcome briefs, pushback only from a strong sidekick", () => {
		const light = fusionPairProfile(
			"anthropic/claude-opus-5.5",
			"api:google/gemini-3.8-flash",
		);
		expect(light).toEqual({
			name: "default",
			briefStyle: "outcome",
			pushback: false,
			sidekickExplores: true,
		});
		expect(
			fusionPairProfile(
				"anthropic/claude-opus-5.5",
				"anthropic/claude-sonnet-5.5",
			).pushback,
		).toBe(true);
		// A sidekick on the lead's own model is as strong as the lead.
		expect(fusionPairProfile("gpt-6-luna", "gpt-6-luna").pushback).toBe(true);
	});

	it("reads the sidekick's model from roleModels.writer, else the lead's", () => {
		expect(
			fusionPairFor("gpt-6.1-sol", { writer: { model: "codex:gpt-6-luna" } })
				.name,
		).toBe("sol+luna");
		expect(fusionPairFor("gpt-6.1-sol", {})).toMatchObject({
			name: "default",
			pushback: true,
		});
	});
});
