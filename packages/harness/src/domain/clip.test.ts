import { expect, it } from "vitest";
import { clip } from "./clip";

it("keeps short text and cuts long text to the limit with a marker", () => {
	expect(clip("abc", 3)).toBe("abc");
	expect(clip("abcdef", 4)).toBe("abc…");
	expect(clip("ab   cdef", 6)).toBe("ab…");
	const cut = clip("x".repeat(50), 30, "\n[truncated]");
	expect(cut).toBe(`${"x".repeat(18)}\n[truncated]`);
	expect(cut.length).toBe(30);
});
