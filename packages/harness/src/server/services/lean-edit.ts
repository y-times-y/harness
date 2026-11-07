/**
 * The exact-string edit engine behind every lean surface's edit tool.
 *
 * An edit first matches its old text exactly. Only when that finds nothing does
 * it retry on a normalized view of both texts: trailing whitespace per line
 * dropped, curly quotes, Unicode dashes and special spaces folded to ASCII,
 * then NFKC. Every normalized code unit remembers the file offset it came
 * from, so a fuzzy match replaces only the matched region of the original
 * file: everything outside it keeps its bytes.
 *
 * patch-input.ts matches apply_patch hunks differently on purpose: line by
 * line, and its last fallback also collapses leading and inner whitespace,
 * since a hunk's context lines are whole lines. Both fold characters the
 * same way (typography-fold.ts).
 */

import { foldCharacter } from "./typography-fold";

export class LeanEditError extends Error {}

/**
 * The normalized text and, for each of its code units, the index in `text`
 * of the character it came from (plus a final entry for the end).
 */
function normalizedWithMap(text: string): {
	text: string;
	map: number[];
} {
	let normalized = "";
	const map: number[] = [];
	let lineStart = 0;
	while (lineStart <= text.length) {
		const newline = text.indexOf("\n", lineStart);
		const lineEnd = newline === -1 ? text.length : newline;
		const kept = text.slice(lineStart, lineEnd).trimEnd().length;
		let offset = lineStart;
		for (const character of text.slice(lineStart, lineStart + kept)) {
			const folded = foldCharacter(character);
			normalized += folded;
			for (let unit = 0; unit < folded.length; unit++) map.push(offset);
			offset += character.length;
		}
		if (newline === -1) break;
		normalized += "\n";
		map.push(newline);
		lineStart = newline + 1;
	}
	map.push(text.length);
	return { text: normalized, map };
}

export function normalizeForMatching(text: string) {
	return normalizedWithMap(text).text;
}

function occurrences(haystack: string, needle: string) {
	const found: number[] = [];
	if (!needle) return found;
	for (
		let at = haystack.indexOf(needle);
		at !== -1;
		at = haystack.indexOf(needle, at + needle.length)
	)
		found.push(at);
	return found;
}

type Range = { start: number; end: number };

/** Where `old` occurs in `content`: exactly, with the file's CRLF endings, or after normalization. */
function findOldText(
	content: string,
	old: string,
): { ranges: Range[]; fuzzy: boolean } {
	const exact = occurrences(content, old);
	if (exact.length)
		return {
			ranges: exact.map((start) => ({ start, end: start + old.length })),
			fuzzy: false,
		};
	if (content.includes("\r\n") && !old.includes("\r\n")) {
		const crlf = old.replaceAll("\n", "\r\n");
		const matches = occurrences(content, crlf);
		if (matches.length)
			return {
				ranges: matches.map((start) => ({ start, end: start + crlf.length })),
				fuzzy: false,
			};
	}
	const wanted = normalizeForMatching(old);
	if (!wanted.trim()) return { ranges: [], fuzzy: true };
	const { text, map } = normalizedWithMap(content);
	return {
		ranges: occurrences(text, wanted).map((start) => ({
			start: map[start],
			end: map[start + wanted.length],
		})),
		fuzzy: true,
	};
}

/** Replacement text in the file's own line endings. */
function inFileEndings(content: string, replacement: string) {
	return content.includes("\r\n") && !replacement.includes("\r\n")
		? replacement.replaceAll("\n", "\r\n")
		: replacement;
}

function applyRanges(
	content: string,
	edits: { range: Range; replacement: string }[],
) {
	let result = content;
	for (const { range, replacement } of [...edits].sort(
		(left, right) => right.range.start - left.range.start,
	))
		result = `${result.slice(0, range.start)}${inFileEndings(content, replacement)}${result.slice(range.end)}`;
	return result;
}

export type LeanEditNames = {
	/** The argument holding the text to replace, as the tool names it. */
	old: string;
	/** The argument that allows several replacements, if the tool has one. */
	all?: string;
};

/** One old→new replacement. */
export function applyLeanEdit(
	content: string | null,
	edit: { old: string; new: string; all?: boolean },
	path: string,
	names: LeanEditNames,
): { content: string; replacements: number; fuzzy: boolean } {
	if (edit.old === edit.new)
		throw new LeanEditError(
			`No changes to make: ${names.old} and the new text are exactly the same.`,
		);
	if (!edit.old) {
		// An empty old string creates a file.
		if (content) {
			throw new LeanEditError(
				`${names.old} is empty but ${path} already has content; copy the text to replace into ${names.old}.`,
			);
		}
		return { content: edit.new, replacements: 1, fuzzy: false };
	}
	if (content === null)
		throw new LeanEditError(
			`${path} does not exist. Create it with an empty ${names.old}, or check the path.`,
		);
	const { ranges, fuzzy } = findOldText(content, edit.old);
	if (!ranges.length)
		throw new LeanEditError(
			`${names.old} was not found in ${path}. It must match the file exactly, including whitespace and indentation; read the file again and copy the text.`,
		);
	if (ranges.length > 1 && !edit.all)
		throw new LeanEditError(
			`Found ${ranges.length} matches of ${names.old} in ${path}, but it must match exactly one place. ${names.all ? `To replace every occurrence, set ${names.all} to true; otherwise include` : "Include"} more surrounding lines so it matches only one.`,
		);
	return {
		content: applyRanges(
			content,
			ranges.map((range) => ({ range, replacement: edit.new })),
		),
		replacements: ranges.length,
		fuzzy,
	};
}

/**
 * The core edit: several replacements, each matched once against the ORIGINAL
 * file (not after earlier ones), with no overlaps; all or nothing.
 */
export function applyLeanEdits(
	content: string | null,
	edits: readonly { old_string: string; new_string: string }[],
	path: string,
): { content: string; replacements: number; fuzzy: boolean } {
	if (content === null)
		throw new LeanEditError(
			`${path} does not exist; create it with write first.`,
		);
	if (!edits.length) throw new LeanEditError("edits is empty.");
	let fuzzy = false;
	const located = edits.map((edit, index) => {
		const label =
			edits.length > 1 ? `edits[${index}].old_string` : "old_string";
		if (!edit.old_string) throw new LeanEditError(`${label} is empty.`);
		const found = findOldText(content, edit.old_string);
		if (!found.ranges.length)
			throw new LeanEditError(
				`${label} is not in ${path}. Copy it from the file as it is now, indentation and line breaks included. Nothing was changed.`,
			);
		if (found.ranges.length > 1)
			throw new LeanEditError(
				`${label} occurs ${found.ranges.length} times in ${path}; add nearby lines until it occurs once. Nothing was changed.`,
			);
		fuzzy ||= found.fuzzy;
		return { range: found.ranges[0], replacement: edit.new_string, label };
	});
	const ordered = [...located].sort(
		(left, right) => left.range.start - right.range.start,
	);
	for (let index = 1; index < ordered.length; index++)
		if (ordered[index].range.start < ordered[index - 1].range.end)
			throw new LeanEditError(
				`${ordered[index - 1].label} and ${ordered[index].label} overlap; combine them into one edit. Nothing was changed.`,
			);
	return {
		content: applyRanges(content, located),
		replacements: located.length,
		fuzzy,
	};
}
