import { describe, expect, it } from "vitest";
import { countDiffLineChanges, countFileChangeLines } from "./diff-stats";

describe("countDiffLineChanges", () => {
	it("counts added and removed lines and ignores file headers", () => {
		expect(
			countDiffLineChanges(`--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@
 keep
-old
+new
+also
`),
		).toEqual({ additions: 2, deletions: 1 });
	});

	it("counts a whole new file when an agent sends the contents instead of a unified diff", () => {
		expect(countFileChangeLines("add", "one\ntwo\nthree\n")).toEqual({
			additions: 3,
			deletions: 0,
		});
		expect(
			countFileChangeLines(
				"add",
				"# todo-cli\n\n- `python3 todo.py add`\n- `python3 todo.py list`\n",
			),
		).toEqual({
			additions: 3,
			deletions: 0,
		});
	});
});
