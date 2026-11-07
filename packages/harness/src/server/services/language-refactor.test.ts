import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { prepareRenameWrites } from "./language-refactor";

const source =
	'const emoji = "😀"; export const old = 1;\r\nconsole.log(old);\r\n';
const snapshot = (
	edits: {
		range: {
			start: { line: number; character: number };
			end: { line: number; character: number };
		};
		newText: string;
	}[],
) => ({
	files: [
		{
			path: "index.ts",
			content: source,
			sha256: createHash("sha256").update(source).digest("hex"),
			edits,
		},
	],
});
const edit = (line: number, start: number, end: number) => ({
	range: { start: { line, character: start }, end: { line, character: end } },
	newText: "renamed",
});
it("applies LSP UTF-16 edits without losing CRLF and rejects overlap, clamped coordinates, broken Unicode and snapshots", () => {
	const start = source.indexOf("old");
	const result = prepareRenameWrites(
		snapshot([edit(0, start, start + 3), edit(1, 12, 15)]),
	)[0];
	expect(result.content).toBe(source.replaceAll("old", "renamed"));
	expect(() => prepareRenameWrites(snapshot([edit(0, 999, 1000)]))).toThrow(
		"outside source",
	);
	expect(() =>
		prepareRenameWrites(
			snapshot([edit(0, start, start + 3), edit(0, start + 1, start + 3)]),
		),
	).toThrow();
	const emoji = source.indexOf("😀");
	expect(() =>
		prepareRenameWrites(snapshot([edit(0, emoji + 1, emoji + 2)])),
	).toThrow("Unicode");
	const stale = snapshot([edit(0, start, start + 3)]);
	stale.files[0].sha256 = "0".repeat(64);
	expect(() => prepareRenameWrites(stale)).toThrow("snapshot");
});
