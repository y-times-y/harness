/**
 * A paste this large becomes a "Pasted text" attachment instead of filling the
 * composer: past either limit, the text goes to a file.
 */
export const PASTED_TEXT_THRESHOLD = {
	characters: 2_000,
	lines: 40,
} as const;

/** The preview shows this much; the agent always gets the whole file. */
export const PASTED_TEXT_PREVIEW_CHARACTERS = 100_000;

/** The tile's faint first lines, kept with the sent message. */
export const PASTED_TEXT_PEEK = { characters: 240, lines: 4 } as const;

export const PASTED_TEXT_MEDIA_TYPE = "text/plain";

const PASTED_TEXT_NAME = /^pasted-(\d+)\.txt$/;

export function lineCount(text: string) {
	if (!text) return 0;
	const breaks = text.match(/\r\n|\r|\n/g)?.length ?? 0;
	// A trailing newline ends the last line rather than starting another.
	return /(?:\r\n|\r|\n)$/.test(text) ? breaks : breaks + 1;
}

export function isLargePaste(text: string) {
	return (
		text.length > PASTED_TEXT_THRESHOLD.characters ||
		lineCount(text) > PASTED_TEXT_THRESHOLD.lines
	);
}

export function pastedTextName(number: number) {
	return `pasted-${number}.txt`;
}

/** The next free number among the files already attached to this draft. */
export function nextPastedTextNumber(names: readonly string[]) {
	const used = names.flatMap((name) => {
		const match = PASTED_TEXT_NAME.exec(name);
		return match ? [Number(match[1])] : [];
	});
	return used.length ? Math.max(...used) + 1 : 1;
}

export function isPastedText(file: {
	readonly name: string;
	readonly mediaType: string;
}) {
	return (
		PASTED_TEXT_NAME.test(file.name) &&
		file.mediaType.split(";")[0]?.trim() === PASTED_TEXT_MEDIA_TYPE
	);
}

export function pastedTextMeta(lines: number | undefined) {
	if (lines === undefined) return "";
	return lines === 1 ? "1 line" : `${lines.toLocaleString("en")} lines`;
}

/** The first few lines, for the tile; whitespace-only lines are skipped. */
export function pastedTextPeek(text: string) {
	return text
		.split(/\r\n|\r|\n/)
		.filter((line) => line.trim())
		.slice(0, PASTED_TEXT_PEEK.lines)
		.join("\n")
		.slice(0, PASTED_TEXT_PEEK.characters);
}

/** What a pasted text attachment keeps for its tile. */
export function pastedTextFields(text: string) {
	return { lines: lineCount(text), peek: pastedTextPeek(text) };
}
