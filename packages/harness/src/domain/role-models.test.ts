import { describe, expect, it } from "vitest";
import {
	DEFAULT_HARNESS_VARIANT,
	harnessVariantChanges,
	harnessVariantFromFlags,
	harnessVariantFromUnknown,
	harnessVariantLabel,
} from "./harness-variant";
import type { FailoverConnection } from "./model-failover";
import {
	DEFAULT_CHECKER_WORKER_MODEL,
	parseRoleModel,
	resolveRoleModel,
	roleModelFor,
	roleModelsFromUnknown,
} from "./role-models";

const KEY = "22222222-2222-4222-8222-222222222222";
const ROUTER = "33333333-3333-4333-8333-333333333333";
const connections: FailoverConnection[] = [
	{
		key: "codex",
		label: "Codex",
		kind: "subscription",
		revision: "",
		models: [
			{ id: "gpt-6.1-sol", label: "GPT-6.1 Sol", reasoning: ["low", "high"] },
			{ id: "gpt-6-luna", label: "GPT-6 Luna", reasoning: ["low", "high"] },
		],
	},
	{
		key: ROUTER,
		label: "OpenRouter",
		kind: "gateway",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		revision: "r",
		models: [
			{ id: "openai/gpt-6-luna", label: "GPT-6 Luna", reasoning: ["low"] },
			{ id: "google/gemini-3.8-flash", label: "Gemini 3.8 Flash" },
		],
	},
	{
		key: KEY,
		label: "Google",
		kind: "key",
		provider: "google",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		revision: "r",
		models: [{ id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" }],
	},
];

const resolve = (model: string, role = "checker" as const) =>
	resolveRoleModel({
		role,
		roleModels: { [role]: parseRoleModel(model) },
		connections,
		parentModel: "gpt-6.1-sol",
	});

describe("role model specs", () => {
	it("parses <model>[@<effort>] strictly", () => {
		expect(parseRoleModel("codex:gpt-6-luna@low")).toEqual({
			model: "codex:gpt-6-luna",
			effort: "low",
		});
		expect(parseRoleModel("api:google/gemini-3.8-flash")).toEqual({
			model: "api:google/gemini-3.8-flash",
		});
		expect(() => parseRoleModel("a@b@c")).toThrow("roleModels expects");
		expect(() => parseRoleModel("x@HIGH")).toThrow("effort");
		expect(() => parseRoleModel("bad model")).toThrow();
	});

	it("reads stored rows leniently", () => {
		expect(
			roleModelsFromUnknown({
				checker: { model: "codex:gpt-6-luna", effort: "low" },
				writer: { model: 3 },
				boss: { model: "x" },
			}),
		).toEqual({ checker: { model: "codex:gpt-6-luna", effort: "low" } });
		expect(roleModelsFromUnknown("nope")).toEqual({});
	});

	it("gives the judge the reviewer's entry unless it has its own", () => {
		const reviewer = { model: "gpt-6-luna" };
		expect(roleModelFor({ reviewer }, "judge")).toBe(reviewer);
		expect(roleModelFor({ reviewer }, "checker")).toBeUndefined();
	});

	it("gives the checker's worker its own entry, else codex:gpt-6-luna", () => {
		expect(roleModelFor(undefined, "checkerWorker")).toEqual(
			DEFAULT_CHECKER_WORKER_MODEL,
		);
		expect(DEFAULT_CHECKER_WORKER_MODEL).toEqual({ model: "codex:gpt-6-luna" });
		const checker = { model: "codex:gpt-6.1-sol" };
		expect(roleModelFor({ checker }, "checkerWorker")).toEqual(
			DEFAULT_CHECKER_WORKER_MODEL,
		);
		const checkerWorker = { model: "api:google/gemini-3.8-flash" };
		expect(roleModelFor({ checker, checkerWorker }, "checkerWorker")).toBe(
			checkerWorker,
		);
		expect(
			harnessVariantFromFlags(["roleModels.checkerWorker=codex:gpt-6-luna@low"])
				.roleModels,
		).toEqual({ checkerWorker: { model: "codex:gpt-6-luna", effort: "low" } });
	});
});

describe("resolving a role's route", () => {
	it("inherits when no entry applies", () => {
		expect(
			resolveRoleModel({
				role: "writer",
				roleModels: {},
				connections,
				parentModel: "gpt-6.1-sol",
			}),
		).toEqual({ kind: "inherit" });
	});

	it("serves codex:<slug> from the plan with the effort", () => {
		expect(resolve("codex:gpt-6-luna@low")).toEqual({
			kind: "role",
			model: {
				harness: "codex",
				listedModelId: "gpt-6-luna",
				reasoning: "low",
				label: "GPT-6 Luna · Codex",
			},
		});
	});

	it("prefers the plan for a bare id, an API key over a gateway for api:", () => {
		expect(resolve("gpt-6-luna")).toMatchObject({
			model: { harness: "codex", listedModelId: "gpt-6-luna" },
		});
		expect(resolve("api:gpt-6-luna")).toMatchObject({
			model: {
				harness: "api",
				listedModelId: `api/${ROUTER}/openai%2Fgpt-6-luna`,
			},
		});
		expect(resolve("api:google/gemini-3.8-flash")).toMatchObject({
			model: {
				harness: "api",
				listedModelId: `api/${KEY}/gemini-3.8-flash`,
			},
		});
	});

	it("checks an exact route against the user's connections", () => {
		expect(resolve(`api/${ROUTER}/google%2Fgemini-3.8-flash`)).toMatchObject({
			kind: "role",
			model: { listedModelId: `api/${ROUTER}/google%2Fgemini-3.8-flash` },
		});
		expect(
			resolve(
				"api/44444444-4444-4444-8444-444444444444/google%2Fgemini-3.8-flash",
			).kind,
		).toBe("fallback");
	});

	it("falls back with a notice naming what is available", () => {
		const result = resolve("codex:gpt-6-astra");
		expect(result.kind).toBe("fallback");
		if (result.kind !== "fallback") return;
		expect(result.notice).toContain("runs on the parent's model gpt-6.1-sol");
		expect(result.notice).toContain("codex:gpt-6-luna");
		expect(
			resolveRoleModel({
				role: "checker",
				roleModels: { checker: { model: "codex:gpt-6-luna" } },
				connections: connections.slice(1),
				parentModel: "x",
			}),
		).toMatchObject({
			kind: "fallback",
			notice: expect.stringContaining("no Codex sign-in"),
		});
	});

	it("keeps the model but drops an effort the route does not offer", () => {
		const result = resolve("api:google/gemini-3.8-flash@high");
		expect(result).toMatchObject({
			kind: "role",
			notice: expect.stringContaining('effort "high" is not offered'),
		});
		if (result.kind === "role") expect(result.model.reasoning).toBeUndefined();
	});
});

describe("roleModels in the harness variant", () => {
	it("parses per-role flags and labels them for the run", () => {
		const variant = harnessVariantFromFlags([
			"review=on,roleModels.checker=codex:gpt-6-luna@low",
			"roleModels.writer=api:google/gemini-3.8-flash",
		]);
		expect(variant.roleModels).toEqual({
			checker: { model: "codex:gpt-6-luna", effort: "low" },
			writer: { model: "api:google/gemini-3.8-flash" },
		});
		expect(harnessVariantLabel(variant)).toBe(
			"review=on,roleModels.writer=api:google/gemini-3.8-flash,roleModels.checker=codex:gpt-6-luna@low",
		);
		expect(() => harnessVariantFromFlags(["roleModels.boss=x"])).toThrow(
			"takes a role in",
		);
	});

	it("stores only a non-empty mapping and reads it back", () => {
		expect(harnessVariantChanges(DEFAULT_HARNESS_VARIANT)).toEqual({});
		const variant = harnessVariantFromFlags(["roleModels.judge=gpt-6-luna"]);
		const stored = JSON.parse(JSON.stringify(harnessVariantChanges(variant)));
		expect(stored).toEqual({ roleModels: { judge: { model: "gpt-6-luna" } } });
		expect(harnessVariantFromUnknown(stored).roleModels).toEqual({
			judge: { model: "gpt-6-luna" },
		});
		expect(harnessVariantLabel(DEFAULT_HARNESS_VARIANT)).toBe("default");
	});
});
