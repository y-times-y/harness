/**
 * One output limit for every lean tool: at most 2000 lines and 50 KB reach
 * the model. File reads keep the head (the model
 * continues with an offset); command output keeps the tail (errors and
 * summaries come last), and the full output stays in a file whose path the
 * tool returns.
 */
export const LEAN_MAX_LINES = 2000;
export const LEAN_MAX_BYTES = 50 * 1024;

export type Truncation = {
	content: string;
	truncated: boolean;
	totalLines: number;
	/** 1-based numbers of the first and last lines shown, within the input. */
	firstLine: number;
	lastLine: number;
};

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

function lineList(text: string) {
	if (!text) return [];
	const lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines;
}

/** Keeps whole lines from the start. A first line over the byte limit is cut. */
export function keepHead(
	text: string,
	limits: { maxLines?: number; maxBytes?: number } = {},
): Truncation {
	const maxLines = limits.maxLines ?? LEAN_MAX_LINES;
	const maxBytes = limits.maxBytes ?? LEAN_MAX_BYTES;
	const lines = lineList(text);
	if (lines.length <= maxLines && bytes(text) <= maxBytes)
		return {
			content: text,
			truncated: false,
			totalLines: lines.length,
			firstLine: lines.length ? 1 : 0,
			lastLine: lines.length,
		};
	const kept: string[] = [];
	let used = 0;
	for (const line of lines) {
		if (kept.length >= maxLines) break;
		const size = bytes(line) + 1;
		if (used + size > maxBytes) {
			if (!kept.length)
				kept.push(Buffer.from(line).subarray(0, maxBytes).toString("utf8"));
			break;
		}
		kept.push(line);
		used += size;
	}
	return {
		content: `${kept.join("\n")}\n`,
		truncated: true,
		totalLines: lines.length,
		firstLine: 1,
		lastLine: kept.length,
	};
}

/** Keeps whole lines from the end. A last line over the byte limit keeps its end. */
export function keepTail(
	text: string,
	limits: { maxLines?: number; maxBytes?: number } = {},
): Truncation {
	const maxLines = limits.maxLines ?? LEAN_MAX_LINES;
	const maxBytes = limits.maxBytes ?? LEAN_MAX_BYTES;
	const lines = lineList(text);
	if (lines.length <= maxLines && bytes(text) <= maxBytes)
		return {
			content: text,
			truncated: false,
			totalLines: lines.length,
			firstLine: lines.length ? 1 : 0,
			lastLine: lines.length,
		};
	const kept: string[] = [];
	let used = 0;
	for (let index = lines.length - 1; index >= 0; index--) {
		if (kept.length >= maxLines) break;
		const line = lines[index];
		const size = bytes(line) + 1;
		if (used + size > maxBytes) {
			if (!kept.length) {
				const encoded = Buffer.from(line);
				kept.unshift(
					encoded.subarray(encoded.length - maxBytes).toString("utf8"),
				);
			}
			break;
		}
		kept.unshift(line);
		used += size;
	}
	return {
		content: kept.join("\n"),
		truncated: true,
		totalLines: lines.length,
		firstLine: lines.length - kept.length + 1,
		lastLine: lines.length,
	};
}

/** The note after truncated command output: which lines are shown and where the rest is. */
export function commandTruncationNote(
	truncation: Pick<Truncation, "firstLine" | "lastLine" | "totalLines">,
	outputPath: string,
) {
	return `[Output cut to lines ${truncation.firstLine}-${truncation.lastLine} of ${truncation.totalLines}; all of it is in ${outputPath}]`;
}
