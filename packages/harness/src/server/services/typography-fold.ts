/**
 * The character folding both edit matchers fall back to when exact text is
 * not found (lean-edit.ts for the lean surfaces' old/new edits, patch-input.ts
 * for apply_patch hunks): curly quotes, Unicode dashes and special spaces to
 * ASCII, then NFKC. Models type the ASCII form of what a file spells with
 * typographic characters, and the other way round. The apply_patch format
 * falls back to a similar folding.
 */

const SINGLE_QUOTES = /[‘’‚‛]/;
const DOUBLE_QUOTES = /[“”„‟]/;
const DASHES = /[‐‑‒–—―−]/;
const SPACES = /[  -   　]/;

/** One character, folded (NFKC may return several code units). */
export function foldCharacter(character: string) {
	if (SINGLE_QUOTES.test(character)) return "'";
	if (DOUBLE_QUOTES.test(character)) return '"';
	if (DASHES.test(character)) return "-";
	if (SPACES.test(character)) return " ";
	return character.normalize("NFKC");
}

/** Every character of `text`, folded. */
export function foldTypography(text: string) {
	let folded = "";
	for (const character of text) folded += foldCharacter(character);
	return folded;
}
