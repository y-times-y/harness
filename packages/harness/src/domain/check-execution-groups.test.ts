import { expect, it } from "vitest";
import { checkExecutionGroups } from "./check-execution-groups";

it("keeps default checks serial and preserves explicit ordered groups", () => {
	expect(checkExecutionGroups(3)).toEqual([[0], [1], [2]]);
	expect(checkExecutionGroups(3, [[0, 2], [1]])).toEqual([[0, 2], [1]]);
	expect(checkExecutionGroups(3, undefined, true)).toEqual([[0, 1, 2]]);
	expect(checkExecutionGroups(3, [[0, 1], [2]], true)).toEqual([[0, 1], [2]]);
});

it("rejects dropped, duplicated, invalid and oversized groups", () => {
	for (const groups of [
		[[0]],
		[[0], [0]],
		[[0, 2]],
		[[], [0, 1]],
		[[0, 1, 2]],
		[[0, 0.5]],
	]) {
		expect(() => checkExecutionGroups(2, groups)).toThrow(
			"every command exactly once",
		);
	}
});
