import { describe, expect, it } from "vitest";
import {
	DEFAULT_HARNESS_VARIANT,
	harnessVariantChanges,
	harnessVariantFromFlags,
	harnessVariantFromUnknown,
	harnessVariantLabel,
	leadReasoningEffort,
	outputCapCharacters,
	promptCacheScopeId,
} from "./harness-variant";

describe("harness variants", () => {
	it("defaults to the lean tools, the rules wording and observer-written memory", () => {
		expect(DEFAULT_HARNESS_VARIANT).toEqual({
			memoryWording: "rules",
			memoryWriter: "observer",
			toolSurface: "lean",
			promptCacheScope: "chat",
			codeMode: "off",
			subagents: "off",
			prEvidence: "on",
			instructions: "default",
			attempts: "1",
			review: "off",
			checkerMode: "single",
			lead: "off",
			leadTools: "thin",
			leadEffort: "high",
			rigor: "off",
			outputCap: "off",
			grind: "off",
			effortMix: "off",
			envSnapshot: "off",
			ledger: "off",
			goal: "off",
			plan: "off",
			helpers: "off",
			fetch: "off",
			prompt: "full",
			search: "hosted",
			checks: "full",
			roleModels: {},
		});
	});

	it("parses repeatable and comma-separated flags strictly", () => {
		expect(harnessVariantFromFlags()).toEqual(DEFAULT_HARNESS_VARIANT);
		const variant = harnessVariantFromFlags([
			"memoryWording=notes",
			"toolSurface=current",
		]);
		expect(variant).toEqual({
			memoryWording: "notes",
			memoryWriter: "observer",
			toolSurface: "current",
			promptCacheScope: "chat",
			codeMode: "off",
			subagents: "off",
			prEvidence: "on",
			instructions: "default",
			attempts: "1",
			review: "off",
			checkerMode: "single",
			lead: "off",
			leadTools: "thin",
			leadEffort: "high",
			rigor: "off",
			outputCap: "off",
			grind: "off",
			effortMix: "off",
			envSnapshot: "off",
			ledger: "off",
			goal: "off",
			plan: "off",
			helpers: "off",
			fetch: "off",
			prompt: "full",
			search: "hosted",
			checks: "full",
			roleModels: {},
		});
		expect(
			harnessVariantFromFlags(["memoryWording=notes,toolSurface=lean-native"]),
		).toEqual({
			memoryWording: "notes",
			memoryWriter: "observer",
			toolSurface: "lean-native",
			promptCacheScope: "chat",
			codeMode: "off",
			subagents: "off",
			prEvidence: "on",
			instructions: "default",
			attempts: "1",
			review: "off",
			checkerMode: "single",
			lead: "off",
			leadTools: "thin",
			leadEffort: "high",
			rigor: "off",
			outputCap: "off",
			grind: "off",
			effortMix: "off",
			envSnapshot: "off",
			ledger: "off",
			goal: "off",
			plan: "off",
			helpers: "off",
			fetch: "off",
			prompt: "full",
			search: "hosted",
			checks: "full",
			roleModels: {},
		});
		expect(
			harnessVariantFromFlags(["memoryWording=notes,memoryWriter=both"]),
		).toMatchObject({ memoryWording: "notes", memoryWriter: "both" });
		expect(() => harnessVariantFromFlags(["memoryWriter=nobody"])).toThrow(
			"accepts both, agent, observer",
		);
		expect(() => harnessVariantFromFlags(["memoryWording=loud"])).toThrow(
			"accepts notes, rules",
		);
		expect(() => harnessVariantFromFlags(["nope=1"])).toThrow("key=value");
		expect(() => harnessVariantFromFlags(["memoryWording"])).toThrow(
			"key=value",
		);
	});

	it("reads stored rows leniently and labels only the changes", () => {
		expect(
			harnessVariantFromUnknown({
				memoryWording: "notes",
				toolSurface: "unknown",
				extra: true,
			}),
		).toEqual({
			memoryWording: "notes",
			memoryWriter: "observer",
			toolSurface: "lean",
			promptCacheScope: "chat",
			codeMode: "off",
			subagents: "off",
			prEvidence: "on",
			instructions: "default",
			attempts: "1",
			review: "off",
			checkerMode: "single",
			lead: "off",
			leadTools: "thin",
			leadEffort: "high",
			rigor: "off",
			outputCap: "off",
			grind: "off",
			effortMix: "off",
			envSnapshot: "off",
			ledger: "off",
			goal: "off",
			plan: "off",
			helpers: "off",
			fetch: "off",
			prompt: "full",
			search: "hosted",
			checks: "full",
			roleModels: {},
		});
		expect(harnessVariantFromUnknown({ memoryWriter: "agent" })).toEqual({
			...DEFAULT_HARNESS_VARIANT,
			memoryWriter: "agent",
		});
		expect(harnessVariantFromUnknown(null)).toEqual(DEFAULT_HARNESS_VARIANT);
		expect(harnessVariantFromUnknown(["rules"])).toEqual(
			DEFAULT_HARNESS_VARIANT,
		);
		const notes = harnessVariantFromFlags(["memoryWording=notes"]);
		expect(harnessVariantChanges(notes)).toEqual({ memoryWording: "notes" });
		expect(harnessVariantLabel(notes)).toBe("memoryWording=notes");
		expect(harnessVariantLabel(DEFAULT_HARNESS_VARIANT)).toBe("default");
		expect(
			harnessVariantLabel(
				harnessVariantFromFlags(["memoryWriter=agent,memoryWording=notes"]),
			),
		).toBe("memoryWording=notes,memoryWriter=agent");
	});

	it("offers code mode only when asked", () => {
		expect(harnessVariantFromFlags(["codeMode=on"]).codeMode).toBe("on");
		expect(() => harnessVariantFromFlags(["codeMode=yes"])).toThrow(
			"accepts off, on",
		);
		expect(harnessVariantLabel(harnessVariantFromFlags(["codeMode=on"]))).toBe(
			"codeMode=on",
		);
	});

	it("offers subagents only when asked", () => {
		expect(DEFAULT_HARNESS_VARIANT.subagents).toBe("off");
		expect(harnessVariantFromFlags(["subagents=on"]).subagents).toBe("on");
		expect(harnessVariantFromUnknown({ subagents: "on" }).subagents).toBe("on");
		expect(harnessVariantFromUnknown({ subagents: "full" }).subagents).toBe(
			"off",
		);
		expect(() => harnessVariantFromFlags(["subagents=full"])).toThrow(
			"accepts off, on",
		);
		expect(
			harnessVariantLabel(
				harnessVariantFromFlags(["subagents=on,codeMode=on"]),
			),
		).toBe("codeMode=on,subagents=on");
	});

	it("offers rigor and an output cap only when asked", () => {
		expect(DEFAULT_HARNESS_VARIANT.rigor).toBe("off");
		expect(outputCapCharacters(DEFAULT_HARNESS_VARIANT.outputCap)).toBe(
			undefined,
		);
		const variant = harnessVariantFromFlags(["rigor=on,outputCap=10000"]);
		expect(variant).toMatchObject({ rigor: "on", outputCap: "10000" });
		expect(outputCapCharacters(variant.outputCap)).toBe(10_000);
		expect(harnessVariantLabel(variant)).toBe("rigor=on,outputCap=10000");
		expect(harnessVariantFromUnknown({ outputCap: "123" }).outputCap).toBe(
			"off",
		);
		expect(() => harnessVariantFromFlags(["outputCap=123"])).toThrow(
			"accepts off, 10000, 16000",
		);
	});

	it("keeps the single checker unless checkerMode=pair is asked", () => {
		expect(DEFAULT_HARNESS_VARIANT.checkerMode).toBe("single");
		const variant = harnessVariantFromFlags([
			"review=on,checkerMode=pair,roleModels.checker=codex:gpt-6.1-sol",
			"roleModels.checkerWorker=codex:gpt-6-luna",
		]);
		expect(variant).toMatchObject({
			review: "on",
			checkerMode: "pair",
			roleModels: {
				checker: { model: "codex:gpt-6.1-sol" },
				checkerWorker: { model: "codex:gpt-6-luna" },
			},
		});
		expect(harnessVariantLabel(variant)).toBe(
			"review=on,checkerMode=pair,roleModels.checker=codex:gpt-6.1-sol,roleModels.checkerWorker=codex:gpt-6-luna",
		);
		expect(harnessVariantFromUnknown({ checkerMode: "trio" }).checkerMode).toBe(
			"single",
		);
		expect(harnessVariantFromUnknown({ checkerMode: "pair" }).checkerMode).toBe(
			"pair",
		);
		expect(() => harnessVariantFromFlags(["checkerMode=trio"])).toThrow(
			"accepts single, pair",
		);
	});

	it("keys the prompt cache per chat unless the variant shares it per account", () => {
		expect(promptCacheScopeId("chat", "chat-1")).toBe("chat-1");
		expect(promptCacheScopeId("chat", "chat-2")).not.toBe(
			promptCacheScopeId("chat", "chat-1"),
		);
		expect(promptCacheScopeId("account", "chat-1")).toBe(
			promptCacheScopeId("account", "chat-2"),
		);
	});

	it("parses the fusion lead's tools and effort, and holds the lead's effort at its ceiling", () => {
		const variant = harnessVariantFromFlags([
			"lead=fusion,leadTools=full,leadEffort=medium",
		]);
		expect(variant).toMatchObject({
			lead: "fusion",
			leadTools: "full",
			leadEffort: "medium",
		});
		expect(harnessVariantLabel(variant)).toBe(
			"lead=fusion,leadTools=full,leadEffort=medium",
		);
		expect(() => harnessVariantFromFlags(["leadEffort=huge"])).toThrow(
			"leadEffort accepts",
		);
		expect(harnessVariantFromFlags(["lead=fusion"])).toMatchObject({
			leadTools: "thin",
			leadEffort: "high",
		});
		expect(leadReasoningEffort("max", "high")).toBe("high");
		expect(leadReasoningEffort("xhigh", "high")).toBe("high");
		expect(leadReasoningEffort("medium", "high")).toBe("medium");
		expect(leadReasoningEffort("minimal", "high")).toBe("minimal");
		expect(leadReasoningEffort("max", "inherit")).toBe("max");
		expect(leadReasoningEffort(undefined, "high")).toBeUndefined();
	});
});
