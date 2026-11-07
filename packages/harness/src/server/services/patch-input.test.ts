import { describe, expect, it } from "vitest";
import {
	applyPatchEdits,
	type PatchFileChange,
	PatchInputError,
	parsePatchText,
} from "./patch-input";

function apply(content: string, patch: string, path = "file.py") {
	const [change] = parsePatchText(patch, path);
	if (change.type !== "update") throw new Error(`unexpected ${change.type}`);
	return applyPatchEdits(content, change.edits, change.path);
}

describe("parsePatchText", () => {
	it("reads git headers, a/b prefixes, renames and /dev/null create/delete", () => {
		const changes = parsePatchText(
			[
				"diff --git a/src/x.py b/src/y.py",
				"similarity index 90%",
				"rename from src/x.py",
				"rename to src/y.py",
				"--- a/src/x.py",
				"+++ b/src/y.py",
				"@@ -1 +1 @@",
				"-a",
				"+b",
				"--- /dev/null",
				"+++ b/new.txt\t2026-01-01 00:00:00",
				"@@ -0,0 +1,2 @@",
				"+one",
				"+two",
				"\\ No newline at end of file",
				"--- a/gone.txt",
				"+++ /dev/null",
				"@@ -1 +0,0 @@",
				"-x",
			].join("\n"),
		);
		expect(changes.map((change) => [change.type, change.path])).toEqual([
			["update", "src/x.py"],
			["create", "new.txt"],
			["delete", "gone.txt"],
		]);
		expect(changes[0]).toMatchObject({ moveTo: "src/y.py" });
		expect(changes[1]).toMatchObject({ content: "one\ntwo" });
	});

	it("parses apply_patch envelopes including fenced input", () => {
		const changes = parsePatchText(
			"```\n*** Begin Patch\n*** Add File: a.txt\n+hi\n*** Delete File: b.txt\n*** End Patch\n```",
		);
		expect(changes).toEqual<PatchFileChange[]>([
			{ type: "create", path: "a.txt", content: "hi\n" },
			{ type: "delete", path: "b.txt" },
		]);
	});

	it("groups consecutive SEARCH/REPLACE blocks for one file", () => {
		const changes = parsePatchText(
			"File: `a.py`\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n<<<<<<< SEARCH\nz\n=======\nw\n>>>>>>> REPLACE",
		);
		expect(changes).toHaveLength(1);
		expect(changes[0]).toMatchObject({ path: "a.py" });
		expect((changes[0] as { edits: unknown[] }).edits).toHaveLength(2);
	});

	it.each([
		["--- a/../x\n+++ b/../x\n@@ -1 +1 @@\n-a\n+b\n"],
		["*** Begin Patch\n*** Add File: /etc/x\n+a\n*** End Patch"],
		["@@ -1 +1 @@\n-a\n+b\n"],
		["<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE"],
		["<<<<<<< SEARCH\na\n=======\nb\n"],
		["diff --git a/i.png b/i.png\nBinary files a/i.png and b/i.png differ"],
		["just some prose"],
	])("rejects unusable input %j with a PatchInputError", (patch) => {
		expect(() => parsePatchText(patch)).toThrow(PatchInputError);
	});
});

describe("hunk application", () => {
	const source = "import os\n\ndef main():\n    value = 1\n    return value\n";

	it("tolerates line-number drift and whitespace-only context differences", () => {
		expect(
			apply(
				source,
				"@@ -40,3 +40,3 @@\n def main():  \n-  value = 1\n+    value = 2\n     return value\n",
			),
		).toBe("import os\n\ndef main():\n    value = 2\n    return value\n");
	});

	it("drops one outer context line like patch fuzz when the rest is unique", () => {
		expect(
			apply(
				source,
				"@@\n stale header line\n def main():\n-    value = 1\n+    value = 3\n     return value\n",
			),
		).toContain("value = 3");
	});

	it("refuses ambiguous context instead of guessing", () => {
		const repeated = "a\nx\nb\na\nx\nb\n";
		expect(() => apply(repeated, "@@ -5,1 +5,1 @@\n-x\n+y\n")).toThrow(
			/ambiguous.*2 places/,
		);
		expect(() => apply(repeated, "@@\n a\n-x\n+y\n b\n")).toThrow(/ambiguous/);
	});

	it("uses End of File markers and no-newline markers", () => {
		expect(
			apply(
				"x\nend\nx\nend\n",
				"*** Begin Patch\n*** Update File: file.py\n@@\n-end\n+END\n*** End of File\n*** End Patch",
			),
		).toBe("x\nend\nx\nEND\n");
		expect(
			apply(
				"a\nb\n",
				"@@ -1,2 +1,2 @@\n a\n-b\n+c\n\\ No newline at end of file\n",
			),
		).toBe("a\nc");
	});

	it("preserves CRLF line endings and inserts by line number without context", () => {
		expect(apply("a\r\nb\r\n", "@@ -1 +1 @@\n-a\n+A\n")).toBe("A\r\nb\r\n");
		expect(apply("a\nb\n", "@@ -1,0 +2 @@\n+inserted\n")).toBe(
			"a\ninserted\nb\n",
		);
	});

	it("reports the expected lines when context does not match", () => {
		expect(() => apply(source, "@@\n-missing line\n+x\n")).toThrow(
			/did not match[\s\S]*missing line/,
		);
	});
});

describe("SEARCH/REPLACE application", () => {
	it("matches whole lines exactly, then ignoring whitespace, never ambiguously", () => {
		const file = "def f():\n    return 1\n\ndef g():\n    return 1\n";
		expect(() =>
			apply(
				file,
				"<<<<<<< SEARCH\n    return 1\n=======\n    return 2\n>>>>>>> REPLACE",
			),
		).toThrow(/ambiguous/);
		expect(
			apply(
				file,
				"<<<<<<< SEARCH\ndef g():\n  return 1\n=======\ndef g():\n    return 2\n>>>>>>> REPLACE",
			),
		).toBe("def f():\n    return 1\n\ndef g():\n    return 2\n");
	});

	it("keeps a missing final newline", () => {
		expect(
			apply("a\nb", "<<<<<<< SEARCH\nb\n=======\nc\n>>>>>>> REPLACE"),
		).toBe("a\nc");
	});
});

describe("absolute paths inside the repository", () => {
	const root = "/home/ubuntu/repo";
	it("are made relative in envelopes and unified diffs", () => {
		const envelope = parsePatchText(
			"*** Begin Patch\n*** Update File: /home/ubuntu/repo/src/a.py\n*** Move to: /home/ubuntu/repo/src/b.py\n@@\n-x\n+y\n*** Add File: c.py\n+z\n*** End Patch",
			undefined,
			root,
		);
		expect(envelope.map((change) => change.path)).toEqual(["src/a.py", "c.py"]);
		expect(envelope[0]).toMatchObject({ moveTo: "src/b.py" });
		const unified = parsePatchText(
			"--- /home/ubuntu/repo/src/a.py\n+++ /home/ubuntu/repo/src/a.py\n@@ -1 +1 @@\n-x\n+y\n",
			undefined,
			root,
		);
		expect(unified.map((change) => change.path)).toEqual(["src/a.py"]);
		const git = parsePatchText(
			"--- a//home/ubuntu/repo/src/a.py\n+++ b//home/ubuntu/repo/src/a.py\n@@ -1 +1 @@\n-x\n+y\n",
			undefined,
			root,
		);
		expect(git.map((change) => change.path)).toEqual(["src/a.py"]);
	});
	it("are refused outside the repository, or without a root", () => {
		for (const path of [
			"/etc/passwd",
			"/home/ubuntu/repo",
			"/home/ubuntu/repository/a.py",
		])
			expect(() =>
				parsePatchText(`*** Add File: ${path}\n+x`, undefined, root),
			).toThrow(PatchInputError);
		expect(() =>
			parsePatchText("*** Add File: /home/ubuntu/repo/a.py\n+x"),
		).toThrow(PatchInputError);
	});
});

describe("typography folding", () => {
	it("matches a hunk typed with ASCII quotes and dashes against curly ones", () => {
		expect(
			apply(
				"title = \u201cWhat\u2019s new \u2013 2026\u201d\nother = 1\n",
				'@@\n-title = "What\'s new - 2026"\n+title = "Changes"\n other = 1\n',
			),
		).toBe('title = "Changes"\nother = 1\n');
	});
});
