// Normalizes the edit formats models naturally produce (unified diffs,
// apply_patch envelopes, SEARCH/REPLACE blocks, whole-file writes) into file changes,
// and applies hunks with whitespace/line-drift tolerance but never ambiguously.

import { foldTypography } from "./typography-fold";

export class PatchInputError extends Error {}

export const PATCH_INPUT_HELP = `Accepted apply_patch inputs (use one):
1. {"patch": "*** Begin Patch\\n*** Update File: app.py\\n@@ def main():\\n-    print('old')\\n+    print('new')\\n*** End Patch"}
2. {"patch": "--- a/app.py\\n+++ b/app.py\\n@@ -1,2 +1,2 @@\\n def main():\\n-    print('old')\\n+    print('new')\\n"}  (use --- /dev/null to create, +++ /dev/null to delete)
3. {"path": "app.py", "patch": "<<<<<<< SEARCH\\n    print('old')\\n=======\\n    print('new')\\n>>>>>>> REPLACE"}
4. {"path": "notes.txt", "content": "complete new file text\\n"}
Paths are repository-relative. Context lines must match the current file; include enough to identify one location.`;

/**
 * The common apply_patch grammar,
 * sent verbatim with the freeform tool so GPT models emit the envelope they are trained on.
 */
export const APPLY_PATCH_LARK_GRAMMAR = `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
`;

export const FREEFORM_PATCH_HELP =
	"apply_patch takes the raw patch text (not JSON): *** Begin Patch, then *** Add File: / *** Update File: / *** Delete File: sections with repository-relative paths, then *** End Patch. Context lines must match the current file.";

type HunkLine = { op: " " | "-" | "+"; text: string };
export type Hunk = {
	oldStart?: number;
	anchors: string[];
	lines: HunkLine[];
	atEnd?: boolean;
	oldNoEol?: boolean;
	newNoEol?: boolean;
};
export type PatchEdit =
	| { kind: "hunk"; hunk: Hunk }
	| { kind: "replace"; search: string; replace: string };
export type PatchFileChange =
	| { type: "create"; path: string; content: string }
	| { type: "write"; path: string; content: string }
	| { type: "delete"; path: string }
	| { type: "update"; path: string; edits: PatchEdit[]; moveTo?: string };

/**
 * A patch path as a repository-relative one. With `root` (the repository's
 * absolute path), an absolute path inside it is made relative first, as
 * the apply_patch format accepts; anything else absolute is refused.
 */
export function repositoryPatchPath(raw: string, root?: string): string {
	let path = raw.trim();
	// Timestamps follow a tab in traditional diff headers.
	path = path.split("\t")[0].trim();
	if (/^".*"$/.test(path)) path = path.slice(1, -1);
	const base = root?.replace(/\/+$/, "");
	if (base && path.startsWith(`${base}/`)) path = path.slice(base.length + 1);
	while (path.startsWith("./")) path = path.slice(2);
	if (
		!path ||
		path.startsWith("/") ||
		/[\\\0]/.test(path) ||
		path.split("/").some((part) => part === ".." || part === ".git" || !part)
	)
		throw new PatchInputError(
			`Invalid path ${JSON.stringify(raw.slice(0, 200))}: use a repository-relative path outside .git without traversal.`,
		);
	return path;
}

type PatchPath = (raw: string) => string;

/**
 * Parses patch text in any accepted format. `path` names the file for
 * headerless input; `root` (the repository's absolute path) lets file headers
 * name files inside it by absolute path.
 */
export function parsePatchText(
	input: string,
	path?: string,
	root?: string,
): PatchFileChange[] {
	const toPath: PatchPath = (raw) => repositoryPatchPath(raw, root);
	let text = input.replaceAll("\r\n", "\n");
	if (/^\*\*\* Begin Patch\s*$|^\*\*\* (Add|Update|Delete) File:/m.test(text))
		return parseCodexEnvelope(stripOuterFence(text), toPath);
	if (/^<{5,9} SEARCH\s*$/m.test(text))
		return parseSearchReplace(text, path, toPath);
	text = stripOuterFence(text);
	if (
		/^(diff --git |--- |\+\+\+ |@@)/m.test(text) ||
		(/^\*\*\* /m.test(text) && /^--- /m.test(text))
	)
		return parseUnifiedDiff(text, path, toPath);
	if (path && /^[-+ ]/m.test(text))
		return [
			{
				type: "update",
				path: toPath(path),
				edits: parseLooseHunks(text.split("\n"), path).map((hunk) => ({
					kind: "hunk" as const,
					hunk,
				})),
			},
		];
	throw new PatchInputError(
		"The patch text is not a recognized format: no '*** Begin Patch' envelope, unified diff headers/@@ hunks, or SEARCH/REPLACE blocks were found.",
	);
}

function stripOuterFence(text: string): string {
	const lines = text.split("\n");
	while (lines.length && !lines[0].trim()) lines.shift();
	while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
	if (lines.length && /^```[\w+-]*\s*$/.test(lines[0])) lines.shift();
	if (lines.length && /^```\s*$/.test(lines[lines.length - 1])) lines.pop();
	return lines.join("\n");
}

function parseCodexEnvelope(
	text: string,
	toPath: PatchPath,
): PatchFileChange[] {
	const lines = text.split("\n");
	const sections: {
		kind: "Add" | "Update" | "Delete";
		path: string;
		moveTo?: string;
		body: string[];
	}[] = [];
	let started = !lines.some((line) => /^\*\*\* Begin Patch\s*$/.test(line));
	for (const line of lines) {
		if (!started) {
			started = /^\*\*\* Begin Patch\s*$/.test(line);
			continue;
		}
		if (/^\*\*\* End Patch\s*$/.test(line)) break;
		const header = /^\*\*\* (Add|Update|Delete) File:\s*(.+)$/.exec(line);
		if (header) {
			sections.push({
				kind: header[1] as "Add" | "Update" | "Delete",
				path: toPath(header[2]),
				body: [],
			});
			continue;
		}
		const current = sections.at(-1);
		const move = /^\*\*\* Move to:\s*(.+)$/.exec(line);
		if (move && current?.kind === "Update") {
			current.moveTo = toPath(move[1]);
			continue;
		}
		if (!current) {
			if (line.trim()) {
				throw new PatchInputError(
					`Expected '*** Add File: <path>', '*** Update File: <path>' or '*** Delete File: <path>' before ${JSON.stringify(line.slice(0, 120))}.`,
				);
			}
			continue;
		}
		current.body.push(line);
	}
	if (!sections.length)
		throw new PatchInputError(
			"The *** Begin Patch envelope contains no Add/Update/Delete File sections.",
		);
	return sections.map((section): PatchFileChange => {
		if (section.kind === "Delete")
			return { type: "delete", path: section.path };
		if (section.kind === "Add") {
			const body = [...section.body];
			while (body.length && body[body.length - 1] === "") body.pop();
			return {
				type: "create",
				path: section.path,
				content: body.length
					? `${body.map((line) => (line.startsWith("+") ? line.slice(1) : line)).join("\n")}\n`
					: "",
			};
		}
		const hunks = parseLooseHunks(section.body, section.path);
		if (!hunks.length && !section.moveTo)
			throw new PatchInputError(
				`*** Update File: ${section.path} has no hunks; add '@@' sections with ' ', '-' and '+' lines.`,
			);
		return {
			type: "update",
			path: section.path,
			edits: hunks.map((hunk) => ({ kind: "hunk" as const, hunk })),
			...(section.moveTo ? { moveTo: section.moveTo } : {}),
		};
	});
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/** Parses '@@'-separated hunks (unified or V4A style); lines before any '@@' form an implicit hunk. */
function parseLooseHunks(lines: string[], path: string): Hunk[] {
	const hunks: Hunk[] = [];
	let current: Hunk | null = null;
	let pendingAnchors: string[] = [];
	let pendingStart: number | undefined;
	const finish = () => {
		if (!current) return;
		while (
			current.lines.length &&
			current.lines[current.lines.length - 1].op === " " &&
			current.lines[current.lines.length - 1].text === ""
		)
			current.lines.pop();
		if (current.lines.some((line) => line.op !== " ")) hunks.push(current);
		current = null;
	};
	for (const line of lines) {
		if (line.startsWith("@@")) {
			const numbered = HUNK_HEADER.exec(line);
			if (current) {
				finish();
				pendingAnchors = [];
				pendingStart = undefined;
			}
			const anchor = (
				numbered ? numbered[5] : line.replace(/^@@+/, "").replace(/@@+$/, "")
			).trim();
			if (anchor) pendingAnchors.push(anchor);
			if (numbered) pendingStart = Number(numbered[1]);
			continue;
		}
		if (/^\*\*\* End of File\s*$/.test(line)) {
			if (current) current.atEnd = true;
			continue;
		}
		if (line.startsWith("\\")) {
			const last = current?.lines.at(-1);
			if (current && last) {
				if (last.op !== "+") current.oldNoEol = true;
				if (last.op !== "-") current.newNoEol = true;
			}
			continue;
		}
		if (!current) {
			if (!line.trim() && !pendingAnchors.length && pendingStart === undefined)
				continue;
			current = {
				anchors: pendingAnchors,
				lines: [],
				...(pendingStart !== undefined ? { oldStart: pendingStart } : {}),
			};
		}
		const op = line[0];
		if (op === " " || op === "-" || op === "+")
			current.lines.push({ op, text: line.slice(1) });
		// Models often drop the leading space from context lines.
		else current.lines.push({ op: " ", text: line });
	}
	finish();
	if (!hunks.length && lines.some((line) => /^[-+]/.test(line)))
		throw new PatchInputError(`The patch for ${path} has no applicable hunks.`);
	return hunks;
}

type UnifiedFile = {
	oldPath?: string;
	newPath?: string;
	renameFrom?: string;
	renameTo?: string;
	newFile?: boolean;
	deletedFile?: boolean;
	body: string[];
};

function parseUnifiedDiff(
	text: string,
	path: string | undefined,
	toPath: PatchPath,
): PatchFileChange[] {
	const lines = text.split("\n");
	const files: UnifiedFile[] = [];
	let inHunks = false;
	const start = (file: UnifiedFile) => {
		files.push(file);
		inHunks = false;
		return file;
	};
	for (let index = 0; index < lines.length; index++) {
		const current = files.at(-1);
		const line = lines[index];
		const next = lines[index + 1] ?? "";
		const gitHeader =
			/^diff --git (?:"?a\/(.+?)"? "?b\/(.+?)"?|(\S+) (\S+))$/.exec(line);
		if (gitHeader) {
			start({
				oldPath: gitHeader[1] ?? gitHeader[3],
				newPath: gitHeader[2] ?? gitHeader[4],
				body: [],
			});
			continue;
		}
		const unifiedHeader = line.startsWith("--- ") && next.startsWith("+++ ");
		// Some models mix context-diff old headers into a unified diff.
		const contextHeader =
			line.startsWith("*** ") &&
			!line.startsWith("*** End") &&
			next.startsWith("--- ");
		if (unifiedHeader || contextHeader) {
			const file: UnifiedFile =
				current && !inHunks && !current.body.length
					? current
					: start({ body: [] });
			file.oldPath = stripDiffPrefix(line.slice(4), "a/");
			file.newPath = stripDiffPrefix(next.slice(4), "b/");
			index++;
			continue;
		}
		if (/^(GIT binary patch|Binary files )/.test(line))
			throw new PatchInputError(
				"Binary patches are not supported; edit text files only.",
			);
		if (current && !inHunks) {
			const file = current;
			const meta =
				/^(new file mode|deleted file mode|index |old mode|new mode|similarity index|dissimilarity index|rename from |rename to |copy from |copy to )(.*)$/.exec(
					line,
				);
			if (meta) {
				if (meta[1] === "new file mode") file.newFile = true;
				if (meta[1] === "deleted file mode") file.deletedFile = true;
				if (meta[1] === "rename from ") file.renameFrom = meta[2];
				if (meta[1] === "rename to ") file.renameTo = meta[2];
				continue;
			}
		}
		if (line.startsWith("@@")) {
			if (!current) {
				if (!path)
					throw new PatchInputError(
						"The diff has @@ hunks but no '--- a/<path>' / '+++ b/<path>' headers; add headers or pass the file in the path field.",
					);
				start({ oldPath: path, newPath: path, body: [] });
			}
			inHunks = true;
			(files.at(-1) as UnifiedFile).body.push(line);
			continue;
		}
		if (current && inHunks) current.body.push(line);
	}
	if (!files.length)
		throw new PatchInputError("The diff contains no file sections.");
	return files.map((file): PatchFileChange => {
		const oldPath = file.renameFrom ?? file.oldPath;
		const newPath = file.renameTo ?? file.newPath;
		const oldMissing = file.newFile || !oldPath || isDevNull(oldPath);
		const newMissing = file.deletedFile || !newPath || isDevNull(newPath);
		if (oldMissing && newMissing)
			throw new PatchInputError("A diff section names no file path.");
		if (oldMissing) {
			const target = toPath(newPath as string);
			const hunks = parseLooseHunks(file.body, target);
			const added = hunks.flatMap((hunk) =>
				hunk.lines.filter((entry) => entry.op !== "-"),
			);
			const noEol = hunks.at(-1)?.newNoEol;
			return {
				type: "create",
				path: target,
				content: added.length
					? `${added.map((entry) => entry.text).join("\n")}${noEol ? "" : "\n"}`
					: "",
			};
		}
		const source = toPath(oldPath as string);
		if (newMissing) return { type: "delete", path: source };
		const target = toPath(newPath as string);
		const hunks = parseLooseHunks(file.body, source);
		if (!hunks.length && source === target)
			throw new PatchInputError(
				`The diff for ${source} has no hunks with '-' or '+' lines.`,
			);
		return {
			type: "update",
			path: source,
			edits: hunks.map((hunk) => ({ kind: "hunk" as const, hunk })),
			...(target !== source ? { moveTo: target } : {}),
		};
	});
}

function isDevNull(path: string) {
	return path.split("\t")[0].trim() === "/dev/null";
}

function stripDiffPrefix(raw: string, prefix: string) {
	const path = raw
		.split("\t")[0]
		.trim()
		.replace(/^"(.*)"$/, "$1");
	return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function parseSearchReplace(
	text: string,
	path: string | undefined,
	toPath: PatchPath,
): PatchFileChange[] {
	const lines = text.split("\n");
	const changes: PatchFileChange[] = [];
	let candidate: string | undefined;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (!/^<{5,9} SEARCH\s*$/.test(line)) {
			const trimmed = line.trim();
			if (trimmed && !/^```/.test(trimmed) && !/^[=>]{5,}/.test(trimmed))
				candidate = trimmed
					.replace(/^(?:#+\s*)?(?:file|path)\s*:\s*/i, "")
					.replace(/^`(.*)`$/, "$1")
					.replace(/^\*\*(.*)\*\*$/, "$1");
			continue;
		}
		const search: string[] = [];
		const replace: string[] = [];
		let section: "search" | "replace" = "search";
		let closed = false;
		for (index++; index < lines.length; index++) {
			const inner = lines[index];
			if (section === "search" && /^={5,9}\s*$/.test(inner)) {
				section = "replace";
				continue;
			}
			if (section === "replace" && /^>{5,9} REPLACE\s*$/.test(inner)) {
				closed = true;
				break;
			}
			(section === "search" ? search : replace).push(inner);
		}
		if (!closed)
			throw new PatchInputError(
				"A SEARCH/REPLACE block is incomplete: each needs '<<<<<<< SEARCH', '=======' and '>>>>>>> REPLACE' lines.",
			);
		const target = path ?? candidate ?? changes.at(-1)?.path;
		if (!target)
			throw new PatchInputError(
				"SEARCH/REPLACE blocks need a file: pass the path field or put the path on the line before '<<<<<<< SEARCH'.",
			);
		const file = toPath(target);
		const edit: PatchEdit = {
			kind: "replace",
			search: search.length ? `${search.join("\n")}\n` : "",
			replace: replace.length ? `${replace.join("\n")}\n` : "",
		};
		const previous = changes.at(-1);
		if (previous?.type === "update" && previous.path === file)
			previous.edits.push(edit);
		else changes.push({ type: "update", path: file, edits: [edit] });
		candidate = undefined;
	}
	return changes;
}

type SplitContent = { lines: string[]; eol: string; finalNewline: boolean };

function splitContent(content: string): SplitContent {
	const eol = content.includes("\r\n") ? "\r\n" : "\n";
	if (!content) return { lines: [], eol, finalNewline: true };
	const finalNewline = content.endsWith("\n");
	const body = finalNewline ? content.slice(0, -1) : content;
	return {
		lines: body.split("\n").map((line) => line.replace(/\r$/, "")),
		eol,
		finalNewline,
	};
}

function joinContent({ lines, eol, finalNewline }: SplitContent) {
	return lines.length ? `${lines.join(eol)}${finalNewline ? eol : ""}` : "";
}

/**
 * Line matchers, strictest first: exact, trailing whitespace ignored, all
 * whitespace runs collapsed, then also typography folded (as lean-edit.ts
 * and the apply_patch format do). Hunks match whole lines, so unlike lean-edit
 * the looser levels also ignore indentation.
 */
const MATCHERS: ((line: string) => string)[] = [
	(line) => line,
	(line) => line.trimEnd(),
	(line) => line.trim().replace(/\s+/g, " "),
	(line) => foldTypography(line).trim().replace(/\s+/g, " "),
];

function findBlock(
	lines: string[],
	block: string[],
	normalize: (line: string) => string,
) {
	const wanted = block.map(normalize);
	const matches: number[] = [];
	for (let start = 0; start + wanted.length <= lines.length; start++) {
		let matched = true;
		for (let offset = 0; offset < wanted.length; offset++)
			if (normalize(lines[start + offset]) !== wanted[offset]) {
				matched = false;
				break;
			}
		if (matched) matches.push(start);
	}
	return matches;
}

function anchorFloor(lines: string[], anchors: string[]) {
	let floor = 0;
	let located = false;
	for (const anchor of anchors) {
		const wanted = anchor.trim();
		let found: number[] = [];
		for (const exact of [true, false]) {
			found = [];
			for (let index = floor; index < lines.length; index++) {
				const line = lines[index].trim();
				if (exact ? line === wanted : line.includes(wanted)) found.push(index);
			}
			if (found.length) break;
		}
		if (found.length === 1) {
			floor = found[0];
			located = true;
		}
	}
	return { floor, located };
}

function describeBlock(block: string[]) {
	const shown = block.slice(0, 4).map((line) => `  ${line}`);
	if (block.length > 4) shown.push(`  ... (${block.length - 4} more lines)`);
	return shown.join("\n");
}

function applyHunk(file: SplitContent, hunk: Hunk, label: string) {
	const lines = file.lines;
	const old = hunk.lines.filter((line) => line.op !== "+").map((l) => l.text);
	const replacementFor = (start: number, hunkLines: HunkLine[]) => {
		const output: string[] = [];
		let cursor = start;
		for (const line of hunkLines) {
			if (line.op === " ") output.push(lines[cursor++]);
			else if (line.op === "-") cursor++;
			else output.push(line.text);
		}
		return output;
	};
	const commit = (start: number, hunkLines: HunkLine[], oldLength: number) => {
		const reachesEnd = start + oldLength === lines.length;
		lines.splice(start, oldLength, ...replacementFor(start, hunkLines));
		if (reachesEnd) {
			if (hunk.newNoEol) file.finalNewline = false;
			else if (hunk.oldNoEol) file.finalNewline = true;
		}
	};
	if (!old.length) {
		let at: number | undefined;
		if (!lines.length) at = 0;
		else if (hunk.atEnd) at = lines.length;
		else if (hunk.anchors.length) {
			const anchor = anchorFloor(lines, hunk.anchors);
			if (anchor.located) at = anchor.floor + 1;
		} else if (hunk.oldStart !== undefined && hunk.oldStart <= lines.length)
			at = hunk.oldStart;
		if (at === undefined)
			throw new PatchInputError(
				`${label} only adds lines and has no context; include a few unchanged lines around the insertion point.`,
			);
		commit(at, hunk.lines, 0);
		return;
	}
	const { floor } = anchorFloor(lines, hunk.anchors);
	const candidates = (block: string[], normalize: (line: string) => string) =>
		findBlock(lines, block, normalize).filter(
			(start) =>
				start >= floor &&
				(!hunk.atEnd || start + block.length === lines.length),
		);
	for (const normalize of MATCHERS) {
		const matches = candidates(old, normalize);
		if (matches.length > 1)
			throw new PatchInputError(
				`${label} is ambiguous: its context matches ${matches.length} places (lines ${matches
					.slice(0, 5)
					.map((start) => start + 1)
					.join(
						", ",
					)}). Add more surrounding unchanged lines or an '@@ <enclosing line>' anchor so it matches exactly one place.`,
			);
		if (matches.length === 1) {
			commit(matches[0], hunk.lines, old.length);
			return;
		}
	}
	// Like patch's fuzz factor 1: drop one outer context line on each side.
	const trimmed = [...hunk.lines];
	if (trimmed[0]?.op === " ") trimmed.shift();
	if (trimmed.at(-1)?.op === " ") trimmed.pop();
	const trimmedOld = trimmed
		.filter((line) => line.op !== "+")
		.map((l) => l.text);
	if (
		trimmed.length < hunk.lines.length &&
		trimmedOld.length >= 2 &&
		trimmed.some((line) => line.op === " ")
	) {
		const matches = candidates(trimmedOld, MATCHERS[2]);
		if (matches.length === 1) {
			commit(matches[0], trimmed, trimmedOld.length);
			return;
		}
		if (matches.length > 1)
			throw new PatchInputError(
				`${label} is ambiguous: its context matches ${matches.length} places. Add more surrounding unchanged lines so it matches exactly one place.`,
			);
	}
	throw new PatchInputError(
		`${label} did not match the current file. Expected these lines (context and '-' lines):\n${describeBlock(old)}\nRead the file again and copy context lines exactly.`,
	);
}

function applyReplace(
	content: string,
	edit: Extract<PatchEdit, { kind: "replace" }>,
	label: string,
): string {
	const crlf = content.includes("\r\n");
	const native = (text: string) =>
		crlf ? text.replaceAll("\n", "\r\n") : text;
	if (!edit.search) {
		if (!content) return native(edit.replace);
		throw new PatchInputError(
			`${label} has an empty SEARCH section, which only creates a new file; copy existing lines into SEARCH to edit this file.`,
		);
	}
	const search = native(edit.search);
	const searchNoNewline = search.replace(/\r?\n$/, "");
	// Exact matches must start at a line boundary so indentation is never split.
	const lineStarts: number[] = [];
	for (
		let at = searchNoNewline ? content.indexOf(searchNoNewline) : -1;
		at !== -1;
		at = content.indexOf(searchNoNewline, at + 1)
	) {
		const end = at + searchNoNewline.length;
		if (
			(at === 0 || content[at - 1] === "\n") &&
			(end === content.length ||
				content.startsWith(search.slice(searchNoNewline.length) || "\n", end))
		)
			lineStarts.push(at);
	}
	if (lineStarts.length > 1)
		throw new PatchInputError(
			`${label} is ambiguous: its SEARCH text occurs ${lineStarts.length} times. Include more surrounding lines so it matches exactly one place.`,
		);
	if (lineStarts.length === 1) {
		const at = lineStarts[0];
		const end = at + searchNoNewline.length;
		const replaced = native(edit.replace);
		const atEnd = end === content.length;
		return `${content.slice(0, at)}${atEnd ? replaced.replace(/\r?\n$/, "") : replaced}${content.slice(atEnd ? end : end + (search.length - searchNoNewline.length))}`;
	}
	const file = splitContent(content);
	const block = edit.search.replace(/\n$/, "").split("\n");
	const replacement = edit.replace
		? edit.replace.replace(/\n$/, "").split("\n")
		: [];
	for (const normalize of MATCHERS.slice(1)) {
		const matches = findBlock(file.lines, block, normalize);
		if (matches.length > 1)
			throw new PatchInputError(
				`${label} is ambiguous: its SEARCH text matches ${matches.length} places. Include more surrounding lines so it matches exactly one place.`,
			);
		if (matches.length === 1) {
			file.lines.splice(matches[0], block.length, ...replacement);
			return joinContent(file);
		}
	}
	throw new PatchInputError(
		`${label} SEARCH text was not found in the current file:\n${describeBlock(block)}\nRead the file again and copy the SEARCH lines exactly.`,
	);
}

/** Applies edits in order to `content`; throws PatchInputError naming the failing edit. */
export function applyPatchEdits(
	content: string,
	edits: PatchEdit[],
	path: string,
): string {
	let current = content;
	edits.forEach((edit, index) => {
		const label = `${edits.length > 1 ? `Edit ${index + 1} of ${edits.length}` : "The edit"} for ${path}`;
		if (edit.kind === "replace") {
			current = applyReplace(current, edit, label);
			return;
		}
		const file = splitContent(current);
		applyHunk(file, edit.hunk, label);
		current = joinContent(file);
	});
	return current;
}

/** True when every edit is a SEARCH/REPLACE with an empty SEARCH (a "create file" edit). */
export function createsFromEmpty(edits: PatchEdit[]) {
	return edits.every((edit) => edit.kind === "replace" && !edit.search);
}
