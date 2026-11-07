import { describe, expect, it } from "vitest";
import {
	composerModelIdForCatalog,
	listedFastModeId,
	listedModelDisplayName,
	listedModelPreferenceFromSessions,
	listedModelRestrictedByProvider,
	listedModelSupportsFastMode,
	listedReasoningFromRow,
	listedReasoningFromVariants,
	preferredListedModelId,
	sessionListedModelIsBlocked,
	submittedListedModelId,
} from "./listed-model";

describe("submittedListedModelId", () => {
	const listed = [
		{ id: "opencode/nemotron-3-ultra-free" },
		{ id: "opencode/muse-spark-1.3-contributor-free" },
		{ id: "opencode/big-pickle" },
	];

	it("keeps a requested id that the connected catalog listed", () => {
		expect(
			submittedListedModelId("opencode/nemotron-3-ultra-free", listed),
		).toBe("opencode/nemotron-3-ultra-free");
	});

	it("picks a listed Zen spark when the client has no model yet", () => {
		expect(submittedListedModelId("", listed)).toBe(
			"opencode/muse-spark-1.3-contributor-free",
		);
		expect(submittedListedModelId("invented/not-listed", listed)).toBe(
			"opencode/muse-spark-1.3-contributor-free",
		);
	});

	it("reuses the last listed id instead of re-preferring Zen spark", () => {
		expect(
			submittedListedModelId("", listed, {
				lastUsedId: "opencode/big-pickle",
			}),
		).toBe("opencode/big-pickle");
	});

	it("skips a listed Zen spark the provider already restricted", () => {
		expect(
			submittedListedModelId("", listed, {
				excludedIds: ["opencode/muse-spark-1.3-contributor-free"],
			}),
		).toBe("opencode/nemotron-3-ultra-free");
	});

	it("skips a requested spark the provider already restricted", () => {
		expect(
			submittedListedModelId(
				"opencode/muse-spark-1.3-contributor-free",
				listed,
				{
					lastUsedId: "opencode/big-pickle",
					excludedIds: ["opencode/muse-spark-1.3-contributor-free"],
				},
			),
		).toBe("opencode/big-pickle");
	});

	it("reuses the last listed id before the catalog loads", () => {
		expect(
			preferredListedModelId([], { lastUsedId: "opencode/big-pickle" }),
		).toBe("opencode/big-pickle");
		expect(
			submittedListedModelId("", [], { lastUsedId: "opencode/big-pickle" }),
		).toBe("opencode/big-pickle");
	});

	it("does not invent an id when the catalog is empty", () => {
		expect(submittedListedModelId("", [])).toBe("");
		expect(preferredListedModelId([])).toBe("");
	});
});

describe("composerModelIdForCatalog", () => {
	const opencode = [
		{ id: "opencode/muse-spark-1.3-contributor-free" },
		{ id: "opencode/big-pickle" },
	];
	const codex = [{ id: "gpt-5.3-codex-spark" }, { id: "gpt-5.3-codex" }];

	it("does not keep another provider's model after the catalog changes", () => {
		expect(
			composerModelIdForCatalog({
				requestedId: "opencode/big-pickle",
				catalog: codex,
				lastUsedForCatalog: "opencode/big-pickle",
			}),
		).toBe("gpt-5.3-codex-spark");
	});

	it("keeps the last model for the connected catalog", () => {
		expect(
			composerModelIdForCatalog({
				requestedId: "",
				catalog: opencode,
				lastUsedForCatalog: "opencode/big-pickle",
			}),
		).toBe("opencode/big-pickle");
	});

	it("shows no model name while the new provider catalog is empty", () => {
		expect(
			composerModelIdForCatalog({
				requestedId: "opencode/big-pickle",
				catalog: [],
				lastUsedForCatalog: "opencode/big-pickle",
			}),
		).toBe("");
	});
});

describe("listedModelPreferenceFromSessions", () => {
	it("reuses a later listed success after a provider-blocked spark turn", () => {
		expect(
			listedModelPreferenceFromSessions({
				harness: "opencode",
				sessions: [
					{
						harness: "opencode",
						listedModelId: "opencode/big-pickle",
						items: [
							{ kind: "userMessage", text: "try pickle" },
							{ kind: "agentMessage", text: "wrote PICKLE_PROOF.md" },
						],
					},
					{
						harness: "opencode",
						listedModelId: "opencode/muse-spark-1.3-contributor-free",
						items: [
							{
								kind: "error",
								message:
									"[user_blocked] Your access has been restricted due to repeated policy violations.",
							},
						],
					},
				],
			}),
		).toEqual({
			listedModelId: "opencode/big-pickle",
			blockedListedModelIds: ["opencode/muse-spark-1.3-contributor-free"],
		});
	});

	it("does not treat an earlier restriction as blocking a later listed success on the same session", () => {
		expect(
			sessionListedModelIsBlocked("opencode/big-pickle", [
				{
					kind: "error",
					message: "[user_blocked] Your access has been restricted",
				},
				{ kind: "userMessage", text: "use pickle" },
				{ kind: "agentMessage", text: "listed-big-pickle-follow-up" },
			]),
		).toBe(false);
		expect(
			listedModelRestrictedByProvider(
				"[user_blocked] Your access has been restricted due to repeated policy violations.",
			),
		).toBe(true);
	});
});

describe("listedModelSupportsFastMode", () => {
	it("only treats an explicit Fast flag as available", () => {
		expect(listedModelSupportsFastMode({})).toBe(false);
		expect(listedModelSupportsFastMode({ supportsFastMode: true })).toBe(true);
		expect(listedModelSupportsFastMode({ fast: true })).toBe(true);
		expect(listedModelSupportsFastMode({ variants: ["fast"] })).toBe(true);
		expect(listedModelSupportsFastMode({ variants: { fast: {} } })).toBe(true);
		expect(listedModelSupportsFastMode({ variants: ["low", "high"] })).toBe(
			false,
		);
		expect(listedModelSupportsFastMode({ supportsFastMode: "yes" })).toBe(
			false,
		);
		expect(
			listedModelSupportsFastMode({
				serviceTiers: [{ id: "fast", name: "Fast" }],
			}),
		).toBe(true);
		expect(
			listedModelSupportsFastMode({
				capabilities: { fast: true },
			}),
		).toBe(true);
		expect(listedFastModeId({ additionalSpeedTiers: ["fast"] })).toBe("fast");
		expect(listedFastModeId({ serviceTiers: [{ name: "Flex" }] })).toBe(
			undefined,
		);
	});
});

describe("listedReasoningFromVariants", () => {
	it("uses listed variant ids and does not invent Fast", () => {
		expect(listedReasoningFromVariants(["minimal", "low", "medium"])).toEqual({
			levels: [
				{ id: "minimal", label: "minimal" },
				{ id: "low", label: "low" },
				{ id: "medium", label: "medium" },
			],
			defaultLevelId: "medium",
		});
		expect(listedReasoningFromVariants(["fast", "low"])).toEqual({
			levels: [{ id: "low", label: "low" }],
			defaultLevelId: "low",
		});
	});

	it("keeps persisted reasoning and plan effort catalogs", () => {
		expect(
			listedReasoningFromRow({
				reasoning: {
					levels: [{ id: "high", label: "high" }],
					defaultLevelId: "high",
				},
			}),
		).toEqual({
			levels: [{ id: "high", label: "high" }],
			defaultLevelId: "high",
		});
		expect(
			listedReasoningFromRow({
				supportedReasoningEfforts: [
					{ reasoningEffort: "low", description: "Faster" },
					{ reasoningEffort: "high", description: "Deeper" },
				],
				defaultReasoningEffort: "high",
			}),
		).toEqual({
			levels: [
				{ id: "low", label: "Faster" },
				{ id: "high", label: "Deeper" },
			],
			defaultLevelId: "high",
		});
		expect(
			listedReasoningFromRow({
				capabilities: { reasoning: true },
			}),
		).toBeUndefined();
	});
});

describe("listedModelDisplayName", () => {
	it("shows the catalog id tail without inventing a label", () => {
		expect(listedModelDisplayName("opencode/big-pickle")).toBe("big-pickle");
		expect(listedModelDisplayName("gpt-5.3-codex-spark")).toBe(
			"gpt-5.3-codex-spark",
		);
		expect(listedModelDisplayName("  ")).toBe("");
	});

	it("keeps an offered model's label when its route is not listed", () => {
		expect(listedModelDisplayName("claude-code/claude-opus-5-5")).toBe(
			"Claude Opus 5.5",
		);
		expect(
			listedModelDisplayName(
				`api/${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}/${encodeURIComponent("anthropic/claude-opus-5.5")}`,
			),
		).toBe("Claude Opus 5.5");
	});
});
