/**
 * `text` cut to at most `limit` characters. A cut text drops trailing
 * whitespace and ends in `marker`, so a reader can tell it was shortened.
 */
export function clip(text: string, limit: number, marker = "…") {
	if (text.length <= limit) return text;
	return `${text.slice(0, Math.max(0, limit - marker.length)).trimEnd()}${marker}`;
}
