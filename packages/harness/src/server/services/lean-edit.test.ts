import { describe, expect, it } from "vitest";
import {
	applyLeanEdit,
	applyLeanEdits,
	LeanEditError,
	normalizeForMatching,
} from "./lean-edit";
import { keepHead, keepTail } from "./lean-output";

const names = { old: "old_string", all: "replace_all" };

describe("exact edits", () => {
	it("replaces one exact occurrence anywhere in a line", () => {
		expect(
			applyLeanEdit(
				"const a = 1;\nconst b = 2;\n",
				{ old: "b = 2", new: "b = 3" },
				"x.ts",
				names,
			),
		).toEqual({
			content: "const a = 1;\nconst b = 3;\n",
			replacements: 1,
			fuzzy: false,
		});
	});

	it("refuses an ambiguous match unless replace_all, naming the flag", () => {
		expect(() =>
			applyLeanEdit("x\nx\n", { old: "x", new: "y" }, "f", names),
		).toThrow(/Found 2 matches of old_string.*set replace_all to true/);
		expect(
			applyLeanEdit("x\nx\n", { old: "x", new: "y", all: true }, "f", names)
				.content,
		).toBe("y\ny\n");
	});

	it("explains a missing match and a no-op edit", () => {
		expect(() =>
			applyLeanEdit("abc", { old: "zzz", new: "y" }, "f", names),
		).toThrow(LeanEditError);
		expect(() =>
			applyLeanEdit("abc", { old: "abc", new: "abc" }, "f", names),
		).toThrow(/No changes to make/);
	});

	it("creates a file from an empty old string, but never overwrites content that way", () => {
		expect(
			applyLeanEdit(null, { old: "", new: "hi\n" }, "f", names).content,
		).toBe("hi\n");
		expect(applyLeanEdit("", { old: "", new: "hi" }, "f", names).content).toBe(
			"hi",
		);
		expect(() =>
			applyLeanEdit("there", { old: "", new: "hi" }, "f", names),
		).toThrow(/already has content/);
		expect(() =>
			applyLeanEdit(null, { old: "a", new: "b" }, "f", names),
		).toThrow(/does not exist/);
	});

	it("matches LF old text in a CRLF file and keeps the file's line endings", () => {
		const content = "one\r\ntwo\r\nthree\r\n";
		expect(
			applyLeanEdit(content, { old: "one\ntwo", new: "1\n2" }, "f", names)
				.content,
		).toBe("1\r\n2\r\nthree\r\n");
	});
});

describe("fuzzy fallback (normalized matching)", () => {
	it("normalizes trailing whitespace, quotes, dashes, spaces and NFKC", () => {
		expect(normalizeForMatching("say “hi”   \nit’s — a b Ａ")).toBe(
			'say "hi"\nit\'s - a b A',
		);
	});

	it("matches despite trailing whitespace in the file and changes only that region", () => {
		const content = "keep  \nfunction f() {   \n  return 1;\n}\nkeep too\t\n";
		const result = applyLeanEdit(
			content,
			{
				old: "function f() {\n  return 1;",
				new: "function f() {\n  return 2;",
			},
			"f.js",
			names,
		);
		expect(result.fuzzy).toBe(true);
		expect(result.content).toBe(
			"keep  \nfunction f() {\n  return 2;\n}\nkeep too\t\n",
		);
	});

	it("matches straight quotes and hyphens the model typed against curly quotes and dashes in the file", () => {
		const content = "title = “What’s new – 2026”\nother = 1\n";
		const result = applyLeanEdit(
			content,
			{ old: 'title = "What\'s new - 2026"', new: 'title = "Changes"' },
			"f.py",
			names,
		);
		expect(result).toMatchObject({ fuzzy: true, replacements: 1 });
		expect(result.content).toBe('title = "Changes"\nother = 1\n');
	});

	it("matches the other way round, and NFKC-equivalent characters", () => {
		const result = applyLeanEdit(
			"x = ＡＢ\ny\n",
			{ old: "x = AB", new: "x = C" },
			"f",
			names,
		);
		expect(result.fuzzy).toBe(true);
		expect(result.content).toBe("x = C\ny\n");
	});

	it("still refuses an ambiguous fuzzy match", () => {
		expect(() =>
			applyLeanEdit("a \nb\na\t\nb\n", { old: "a\nb", new: "c" }, "f", names),
		).toThrow(/Found 2 matches/);
	});

	it("never matches an old string that normalizes to whitespace only", () => {
		expect(() =>
			applyLeanEdit("a\n\n  \n", { old: "  ", new: "x" }, "f", names),
		).toThrow(/not found/);
	});
});

describe("multi-edit", () => {
	it("matches every edit against the original file and applies them together", () => {
		const result = applyLeanEdits(
			"alpha\nbeta\ngamma\n",
			[
				{ old_string: "gamma", new_string: "GAMMA" },
				{ old_string: "alpha", new_string: "beta" },
				// Matched in the original, so the new "beta" above does not make this ambiguous.
				{ old_string: "beta\n", new_string: "BETA\n" },
			],
			"f",
		);
		expect(result.content).toBe("beta\nBETA\nGAMMA\n");
		expect(result.replacements).toBe(3);
	});

	it("is all or nothing: one missing, ambiguous or overlapping edit applies none", () => {
		expect(() =>
			applyLeanEdits(
				"a b c",
				[
					{ old_string: "a", new_string: "x" },
					{ old_string: "zzz", new_string: "y" },
				],
				"f",
			),
		).toThrow(/edits\[1\]\.old_string.*Nothing was changed/);
		expect(() =>
			applyLeanEdits("a a", [{ old_string: "a", new_string: "x" }], "f"),
		).toThrow(/occurs 2 times/);
		expect(() =>
			applyLeanEdits(
				"abcdef",
				[
					{ old_string: "abc", new_string: "x" },
					{ old_string: "cde", new_string: "y" },
				],
				"f",
			),
		).toThrow(/overlap/);
	});

	it("falls back to the fuzzy match per edit", () => {
		expect(
			applyLeanEdits(
				"if (x) {  \n  go();\n}\n",
				[{ old_string: "if (x) {\n  go();", new_string: "if (y) {\n  go();" }],
				"f",
			),
		).toMatchObject({ content: "if (y) {\n  go();\n}\n", fuzzy: true });
	});
});

describe("output limits", () => {
	const lines = (count: number) =>
		Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");

	it("keeps the head for reads and the tail for commands, by lines", () => {
		const head = keepHead(lines(3000));
		expect(head).toMatchObject({
			truncated: true,
			totalLines: 3000,
			firstLine: 1,
			lastLine: 2000,
		});
		expect(head.content.startsWith("line 1\n")).toBe(true);
		const tail = keepTail(lines(3000));
		expect(tail).toMatchObject({ firstLine: 1001, lastLine: 3000 });
		expect(tail.content.endsWith("line 3000")).toBe(true);
	});

	it("stops at 50 KB, whole lines first, cutting a single huge line", () => {
		const text = `${"x".repeat(30_000)}\n${"y".repeat(30_000)}\n`;
		expect(keepHead(text)).toMatchObject({ truncated: true, lastLine: 1 });
		expect(keepTail(text)).toMatchObject({ truncated: true, firstLine: 2 });
		const huge = "z".repeat(80_000);
		expect(Buffer.byteLength(keepTail(huge).content)).toBe(50 * 1024);
		expect(keepTail("short\n")).toMatchObject({
			truncated: false,
			content: "short\n",
		});
	});
});
