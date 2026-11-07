import { describe, expect, it } from "vitest";
import {
	builderRemaining,
	childSubagentBudget,
	isReaderRole,
	liveChildrenAllowed,
	overlappingWriters,
	SUBAGENT_LEVEL_LIMITS,
	SUBAGENT_TREE_TOKEN_BUDGET,
	subagentAdmission,
	subagentBudgetState,
	subagentLabelFromTaskLabel,
	subagentPlacement,
	subagentRemaining,
	subagentReportHeader,
	writerPatchBlock,
	writerPatchExclusion,
} from "./subagent";
import { subagentWrapUpNotice } from "./subagent-instructions";

describe("subagent placement", () => {
	it("forks writers and shares the VM read-only with every reader role", () => {
		expect(subagentPlacement("writer")).toBe("fork");
		for (const role of ["researcher", "reviewer", "checker"] as const) {
			expect(subagentPlacement(role)).toBe("shared-read-only");
			expect(isReaderRole(role)).toBe(true);
		}
		expect(isReaderRole("writer")).toBe(false);
		expect(isReaderRole(null)).toBe(false);
	});
});

describe("subagent budgets", () => {
	it("gives the builder's children level-1 limits while the tree has room", () => {
		expect(childSubagentBudget(1, builderRemaining(0))).toEqual({
			steps: 150,
			minutes: 30,
			tokens: 2_000_000,
		});
	});

	it("never gives a child more than half of what its parent has left", () => {
		const parent = subagentRemaining(SUBAGENT_LEVEL_LIMITS[1], {
			steps: 100,
			minutes: 25,
			tokens: 1_900_000,
		});
		const child = childSubagentBudget(2, parent);
		expect(child).toEqual({ steps: 25, minutes: 2, tokens: 50_000 });
		for (const key of ["steps", "minutes", "tokens"] as const)
			expect(child?.[key]).toBeLessThanOrEqual(parent[key] / 2);
		expect(
			childSubagentBudget(3, {
				steps: 1000,
				minutes: 1000,
				tokens: 10_000_000,
			}),
		).toEqual({ steps: 40, minutes: 8, tokens: 500_000 });
	});

	it("caps the builder's children at half of the tree's remaining tokens", () => {
		const nearlySpent = builderRemaining(SUBAGENT_TREE_TOKEN_BUDGET - 600_000);
		expect(childSubagentBudget(1, nearlySpent)?.tokens).toBe(300_000);
		expect(
			childSubagentBudget(1, builderRemaining(SUBAGENT_TREE_TOKEN_BUDGET)),
		).toBeNull();
	});

	it("asks for a wrap-up at 90% and stops at 100% of any dimension", () => {
		const budget = { steps: 100, minutes: 10, tokens: 1_000_000 };
		expect(
			subagentBudgetState(budget, { steps: 50, minutes: 2, tokens: 1000 }),
		).toEqual({ state: "ok" });
		expect(
			subagentBudgetState(budget, { steps: 90, minutes: 2, tokens: 1000 }),
		).toMatchObject({ state: "wrap-up", reason: "steps 90/100" });
		expect(
			subagentBudgetState(budget, {
				steps: 10,
				minutes: 2,
				tokens: 1_000_000,
			}),
		).toMatchObject({
			state: "exhausted",
			reason: "tokens 1,000,000/1,000,000",
		});
	});

	it("warns a checker earlier on minutes so it can write its verdict", () => {
		const budget = { steps: 100, minutes: 10, tokens: 1_000_000 };
		const used = { steps: 5, minutes: 8, tokens: 1000 };
		expect(subagentBudgetState(budget, used)).toEqual({ state: "ok" });
		expect(subagentBudgetState(budget, used, 2)).toMatchObject({
			state: "wrap-up",
			reason: "minutes 8/10",
		});
		expect(subagentWrapUpNotice("minutes 8/10", "checker")).toMatch(
			/^Budget nearly used \(minutes 8\/10\)\. Stop investigating and answer now with only the JSON/,
		);
		expect(subagentWrapUpNotice("x", "researcher")).toContain("Wrap up now");
	});
});

describe("subagent admission", () => {
	const roomy = builderRemaining(0);

	it("admits the builder's first child at level 1", () => {
		expect(
			subagentAdmission({
				parentLevel: 0,
				liveChildrenOfParent: 0,
				liveInTree: 0,
				parentRemaining: roomy,
			}),
		).toMatchObject({ admitted: true, level: 1 });
	});

	it("refuses a spawn from level 3 and tells the agent to do the work itself", () => {
		const refused = subagentAdmission({
			parentLevel: 3,
			liveChildrenOfParent: 0,
			liveInTree: 1,
			parentRemaining: roomy,
		});
		expect(refused.admitted).toBe(false);
		expect(refused.admitted ? "" : refused.reason).toMatch(
			/level 3 cannot spawn\. Do this work yourself\./,
		);
		expect(liveChildrenAllowed(3)).toBe(0);
	});

	it("caps live children per level and live agents per tree", () => {
		const admitted = (parentLevel: number, children: number, tree: number) =>
			subagentAdmission({
				parentLevel,
				liveChildrenOfParent: children,
				liveInTree: tree,
				parentRemaining: roomy,
			}).admitted;
		expect(admitted(0, 3, 3)).toBe(true);
		expect(admitted(0, 4, 4)).toBe(false);
		expect(admitted(1, 3, 4)).toBe(true);
		expect(admitted(1, 4, 5)).toBe(false);
		expect(admitted(2, 1, 3)).toBe(true);
		expect(admitted(2, 2, 3)).toBe(false);
		expect(admitted(1, 1, 8)).toBe(false);
	});

	it("refuses when the parent's remaining budget is too small to split", () => {
		expect(
			subagentAdmission({
				parentLevel: 1,
				liveChildrenOfParent: 0,
				liveInTree: 1,
				parentRemaining: { steps: 6, minutes: 20, tokens: 1_000_000 },
			}).admitted,
		).toBe(false);
	});
});

describe("subagent reports", () => {
	it("labels and summarizes a finished writer like the decision's example", () => {
		expect(subagentLabelFromTaskLabel("Task 1.2")).toBe("1.2");
		expect(
			subagentReportHeader({
				label: "1.2",
				role: "writer",
				outcome: "finished",
				steps: 41,
				minutes: 6.2,
				tokens: 380_000,
			}),
		).toBe("[agent 1.2 writer finished · 41 steps · 6m · 380k tokens]");
		expect(
			subagentReportHeader({
				label: "1",
				role: "researcher",
				outcome: "budget exhausted",
				steps: 150,
				minutes: 30,
				tokens: 2_100_000,
				costUsd: 1.234,
			}),
		).toBe(
			"[agent 1 researcher budget exhausted · 150 steps · 30m · 2.1M tokens · $1.23]",
		);
	});

	it("flags sibling writers that touched the same files", () => {
		const overlaps = overlappingWriters(
			["src/api/user.ts", "src/a.ts"],
			[
				{ label: "1.3", files: ["src/api/user.ts"] },
				{ label: "1.4", files: ["src/b.ts"] },
			],
		);
		expect(overlaps).toEqual([{ label: "1.3", files: ["src/api/user.ts"] }]);
		const block = writerPatchBlock(
			{
				path: "~/.ytimesy/agents/1.2.patch",
				files: ["src/api/user.ts", "src/a.ts"],
				added: 120,
				removed: 30,
				sha256: "a".repeat(64),
				ref: "refs/ytimesy/agents/1.2",
				base: "abc123",
			},
			overlaps,
		);
		expect(block).toContain(
			"Patch: ~/.ytimesy/agents/1.2.patch (2 files, +120 −30",
		);
		expect(block).toContain("Ref:   refs/ytimesy/agents/1.2   Base: abc123");
		expect(block).toContain("Overlaps with: agent 1.3 (src/api/user.ts)");
		expect(block).toContain("git apply -3");
		expect(writerPatchBlock(null, [])).toBe("Patch: no changes.");
	});
});

describe("writer patch contents", () => {
	const file = (path: string, bytes = 100, binary = false) => ({
		path,
		bytes,
		binary,
	});
	it("keeps new source and small assets, and leaves scratch and large binaries out", () => {
		expect(writerPatchExclusion(file("src/new.ts"), "")).toBeNull();
		expect(writerPatchExclusion(file("icon.png", 4_000, true), "")).toBeNull();
		expect(writerPatchExclusion(file("tmp/page.html"), "")).toBe("scratch");
		expect(writerPatchExclusion(file("a/Downloads/x.json"), "")).toBe(
			"scratch",
		);
		expect(writerPatchExclusion(file("node_modules/x/i.js"), "")).toBe(
			"scratch",
		);
		// A file merely named like a scratch directory is not one.
		expect(writerPatchExclusion(file("src/cache"), "")).toBeNull();
		expect(writerPatchExclusion(file("photo.jpg", 150_000, true), "")).toBe(
			"binary",
		);
		expect(writerPatchExclusion(file("dump.json", 2_000_000), "")).toBe(
			"large",
		);
	});
	it("keeps a file the brief names, by path or by name", () => {
		expect(
			writerPatchExclusion(
				file("out/photo.jpg", 150_000, true),
				"Save photo.jpg",
			),
		).toBeNull();
		expect(
			writerPatchExclusion(
				file("downloads/data.csv"),
				"put downloads/data.csv in",
			),
		).toBeNull();
	});
	it("warns about an unusually large patch and lists left-out files", () => {
		const patch = {
			path: "/home/u/.ytimesy/agents/2.patch",
			files: Array.from({ length: 51 }, (_, index) => `f${index}`),
			added: 3426,
			removed: 0,
			sha256: "b".repeat(64),
			ref: "refs/ytimesy/agents/2",
			base: "base1",
		};
		expect(writerPatchBlock(patch, [])).toContain(
			"Warning: this patch is unusually large",
		);
		const block = writerPatchBlock(
			{
				...patch,
				files: ["src/a.ts"],
				added: 10,
				excluded: {
					count: 9,
					bytes: 3 * 1024 * 1024,
					paths: ["downloads/a.png", "downloads/b.png"],
				},
			},
			[],
		);
		expect(block).not.toContain("unusually large");
		expect(block).toContain(
			"Left out: 9 new files (3.0 MB) in scratch, download or cache directories or large binaries the brief did not name: downloads/a.png, downloads/b.png, …",
		);
	});
});

describe("stopping a subagent", () => {
	it("wraps up until the stop step, then counts as exhausted", () => {
		const budget = {
			steps: 100,
			minutes: 30,
			tokens: 1_000_000,
			stopAtStep: 13,
		};
		const used = { steps: 10, minutes: 1, tokens: 10 };
		expect(subagentBudgetState(budget, used)).toEqual({
			state: "wrap-up",
			reason: "the parent asked you to stop",
		});
		expect(subagentBudgetState(budget, { ...used, steps: 13 })).toEqual({
			state: "exhausted",
			reason: "stopped by the parent",
		});
	});
});
