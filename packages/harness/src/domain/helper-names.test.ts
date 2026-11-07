import { describe, expect, it } from "vitest";
import {
	HELPER_COLORS,
	helperColor,
	helperIdentitiesOf,
	helperName,
	helperReference,
	helperShortName,
} from "./helper-names";

describe("helper short names", () => {
	it("names every kind by its tag, lowercased, and its number", () => {
		expect(helperShortName("sidekick", 1)).toBe("build-1");
		expect(helperShortName("writer", 2)).toBe("build-2");
		expect(helperShortName("researcher", 1)).toBe("research-1");
		expect(helperShortName("reviewer", 1)).toBe("review-1");
		expect(helperShortName("checker", 3)).toBe("verify-3");
	});
	it("tells the lead the short name with the task", () => {
		expect(helperReference("review-1", "Review the patch")).toBe(
			'review-1 ("Review the patch")',
		);
	});
	it("cuts a long task title cleanly at a word", () => {
		expect(
			helperName(
				"Investigate why the nightly export job drops rows with null customer ids",
			),
		).toBe("Investigate why the nightly export…");
		expect(helperName("  ")).toBe("Untitled task");
	});
	it("reads a slug title as words", () => {
		expect(helperName("package-research")).toBe("Package research");
		expect(helperName("build_helper")).toBe("Build helper");
		expect(helperName("Fix pricing rounding")).toBe("Fix pricing rounding");
		expect(helperName("README")).toBe("README");
	});
});

describe("helper colours", () => {
	it("takes red, green, blue, orange, gold, then paler versions, in start order", () => {
		expect(HELPER_COLORS).toHaveLength(10);
		expect(new Set(HELPER_COLORS).size).toBe(10);
		expect(helperColor(0)).toBe("#FF8F96");
		expect(helperColor(4)).toBe("#E0BA31");
		// The sixth helper gets a paler red, not the first's red.
		expect(helperColor(5)).toBe("#FFC1C5");
		expect(helperColor(7)).toBe("#BBDDFF");
		// After ten the ten repeat.
		expect(helperColor(10)).toBe("#FF8F96");
	});
	it("numbers and colours helpers by start order, whatever order they come in", () => {
		const helpers = [
			{ id: "c", createdAt: "2026-10-21T10:02:00Z", kind: "writer" },
			{ id: "a", createdAt: "2026-10-21T10:00:00Z", kind: "researcher" },
			{ id: "b", createdAt: "2026-10-21T10:01:00Z", kind: "researcher" },
		] as const;
		const ids = helperIdentitiesOf(
			helpers.map((helper) => ({ ...helper, title: `Task ${helper.id}` })),
		);
		expect([...ids.entries()].map(([id, identity]) => [id, identity])).toEqual([
			[
				"a",
				{
					name: "research-1",
					task: "Task a",
					kind: "researcher",
					icon: "search",
					color: "#FF8F96",
				},
			],
			[
				"b",
				{
					name: "research-2",
					task: "Task b",
					kind: "researcher",
					icon: "search",
					color: "#9CD242",
				},
			],
			[
				"c",
				{
					name: "build-1",
					task: "Task c",
					kind: "writer",
					icon: "hammer",
					color: "#83C1FF",
				},
			],
		]);
	});
});
