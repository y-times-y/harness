import { expect, it } from "vitest";
import {
	taskIntegrationChecks,
	taskVerificationPlan,
} from "./task-integration-checks";

it("overlaps only explicitly independent baseline groups without dropping or reordering checks", () => {
	const input = {
		recipe: JSON.stringify({
			checks: ["lint", "types", "test", "build"],
			parallelChecks: [["lint", "types"]],
		}),
		manifest: null,
		files: [],
	};
	expect(taskVerificationPlan(input)).toEqual([
		["lint", "types"],
		["test"],
		["build"],
	]);
	expect(
		taskVerificationPlan({
			...input,
			recipe: JSON.stringify({ checks: ["lint", "types", "test"] }),
		}),
	).toEqual([["lint"], ["types"], ["test"]]);
	for (const group of [
		["lint", "test"],
		["test", "lint"],
		["types", "missing"],
		["lint", "lint"],
	])
		expect(() =>
			taskVerificationPlan({
				...input,
				recipe: JSON.stringify({
					checks: ["lint", "types", "test"],
					parallelChecks: [group],
				}),
			}),
		).toThrow();
});

it("runs all baseline project checks rather than model-selected smoke commands", () => {
	expect(
		taskIntegrationChecks({
			recipe: null,
			manifest: JSON.stringify({
				scripts: {
					test: "vitest run",
					build: "vite build",
					typecheck: "tsc",
					lint: "biome check .",
					dev: "vite",
				},
			}),
			files: ["pnpm-lock.yaml"],
		}),
	).toEqual([
		"corepack pnpm run lint",
		"corepack pnpm run typecheck",
		"corepack pnpm run test",
		"corepack pnpm run build",
	]);
});
it("preserves configured scripts without adding reporting or suppression flags", () => {
	expect(
		taskIntegrationChecks({
			recipe: null,
			files: [],
			manifest: JSON.stringify({
				scripts: { test: "vitest run", build: "vite build" },
			}),
		}),
	).toEqual(["npm run test", "npm run build"]);
	expect(
		taskIntegrationChecks({
			recipe: null,
			files: [],
			manifest: JSON.stringify({
				scripts: { test: "vitest run && custom-check", build: "custom-build" },
			}),
		}),
	).toEqual(["npm run test", "npm run build"]);
});
it("uses the existing project's recipe and deduplicates checks", () => {
	expect(
		taskIntegrationChecks({
			recipe: JSON.stringify({
				verify: ["cargo test"],
				checks: ["cargo test", "cargo clippy"],
			}),
			manifest: null,
			files: [],
		}),
	).toEqual(["cargo test", "cargo clippy"]);
});
it("does not declare an unconfigured or testless project verified", () => {
	for (const input of [
		{ recipe: null, manifest: null, files: [] },
		{ recipe: "{}", manifest: null, files: [] },
		{ recipe: null, manifest: '{"scripts":{"build":"vite build"}}', files: [] },
	])
		expect(() => taskIntegrationChecks(input)).toThrow();
});
