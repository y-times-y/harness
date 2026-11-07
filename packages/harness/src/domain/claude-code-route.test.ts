import { expect, it } from "vitest";
import { API_MODEL_LIST } from "./api-model-list";
import { matchesModelSearch } from "./browse-models";
import {
	claudeCodeCoveredOpenRouterIds,
	claudeCodeListedModels,
	claudeCodeSearchMatches,
} from "./claude-code-route";

it("finds the connected Claude subscription's models in a picker search", () => {
	const models = claudeCodeListedModels();
	expect(claudeCodeSearchMatches(models, "Opus 5.5")).toEqual([
		{ id: "claude-code/claude-opus-5-5", label: "Claude Opus 5.5" },
	]);
	expect(claudeCodeSearchMatches(models, "claude")).toHaveLength(3);
	expect(claudeCodeSearchMatches(models, "anthropic")).toHaveLength(3);
	expect(claudeCodeSearchMatches(models, "gpt")).toEqual([]);
	expect(claudeCodeSearchMatches(models, "  ")).toEqual([]);
	// A refused or disconnected subscription lists no models, so search finds none.
	expect(claudeCodeSearchMatches([], "Opus 5.5")).toEqual([]);
});

it("hides the locked API-key copy of a model the subscription covers", () => {
	const covered = claudeCodeCoveredOpenRouterIds(
		claudeCodeSearchMatches(claudeCodeListedModels(), "Opus 5.5"),
	);
	const locked = API_MODEL_LIST.filter(
		(model) =>
			matchesModelSearch(model, "Opus 5.5") &&
			!covered.includes(model.openRouterId),
	);
	expect(covered).toEqual(["anthropic/claude-opus-5.5"]);
	expect(locked.map((model) => model.label)).not.toContain("Claude Opus 5.5");
	expect(claudeCodeCoveredOpenRouterIds([])).toEqual([]);
});

it("offers no context window option: the subscription's models already run 1M", () => {
	// code.claude.com/docs/en/model-config: Opus, Sonnet and Haiku 5.5 run the
	// 1M window by default, and a [1m] suffix has no effect on them.
	expect(
		claudeCodeListedModels().filter((model) => model.contextWindow),
	).toEqual([]);
});
