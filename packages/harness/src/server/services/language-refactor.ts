import { createHash } from "node:crypto";
import { TextDocument } from "vscode-languageserver-textdocument";
import { z } from "zod";
import { repositoryToolPath } from "./repository-tool-path";

const position = z.object({
	line: z.number().int().min(0),
	character: z.number().int().min(0),
});
const textEdit = z
	.object({
		range: z.object({ start: position, end: position }),
		newText: z.string().max(100_000),
	})
	.strict();
export const renameSources = z.object({
	files: z
		.array(
			z.object({
				path: repositoryToolPath,
				content: z.string().max(200_000),
				sha256: z.string().regex(/^[a-f0-9]{64}$/),
				edits: z.array(textEdit).max(500),
			}),
		)
		.min(1)
		.max(8),
});

/** Reject invalid LSP coordinates rather than letting TextDocument clamp them to another location. */
export function prepareRenameWrites(input: z.infer<typeof renameSources>) {
	const { files } = renameSources.parse(input);
	const paths = new Set<string>();
	let bytes = 0;
	return files.map((file) => {
		if (paths.has(file.path)) throw new Error("Duplicate rename target.");
		paths.add(file.path);
		bytes += Buffer.byteLength(file.content);
		if (
			bytes > 200_000 ||
			createHash("sha256").update(file.content).digest("hex") !== file.sha256
		)
			throw new Error("Invalid or oversized rename source snapshot.");
		const document = TextDocument.create(file.path, "", 0, file.content);
		for (const edit of file.edits) {
			const offsets = [edit.range.start, edit.range.end].map((position) => {
				const offset = document.offsetAt(position);
				const resolved = document.positionAt(offset);
				if (
					resolved.line !== position.line ||
					resolved.character !== position.character
				)
					throw new Error("Rename position is outside source.");
				const before = file.content.charCodeAt(offset - 1),
					after = file.content.charCodeAt(offset);
				if (
					before >= 0xd800 &&
					before <= 0xdbff &&
					after >= 0xdc00 &&
					after <= 0xdfff
				)
					throw new Error("Rename position splits a Unicode character.");
				return offset;
			});
			if (offsets[0] > offsets[1]) throw new Error("Reversed rename range.");
		}
		const content = TextDocument.applyEdits(document, file.edits);
		if (Buffer.byteLength(content) > 1_000_000)
			throw new Error("Rename result exceeds file limit.");
		return {
			operation: "write",
			path: file.path,
			content,
			expectedSha256: file.sha256,
		};
	});
}
