/**
 * Degenerate sampling: a model whose streamed output (answer text or a tool
 * call's arguments) turns into one long run of whitespace. Luna on Bedrock
 * once streamed 64K tokens of blank lines inside one run_code call, 15-17 MB
 * over 6-8.5 minutes, until its output cap. Shared
 * by the product's model loop and the transport guard.
 */

/** Characters of unbroken whitespace in streamed output that count as degenerate sampling. */
export const DEGENERATE_RUN_CHARS = 8_000;

/** A response cut because its output became a whitespace run ("terminated": the loop resamples it as an interrupted stream). */
export class DegenerateOutput extends Error {
	constructor(readonly runChars: number) {
		super(
			`Model response terminated: its output became ${runChars} characters of unbroken whitespace (degenerate sampling).`,
		);
		this.name = "DegenerateOutput";
	}
}

/**
 * Tracks the current run of whitespace across output deltas. Tool-call
 * arguments are JSON text, so an escaped newline, tab or carriage return (a
 * backslash and n, t or r) counts as whitespace too.
 */
export function whitespaceRun() {
	let run = 0;
	return (delta: string) => {
		const plain = delta.replace(/\\[nrt]/g, " ");
		if (!plain.trim()) run += delta.length;
		else {
			const tail = /\s*$/.exec(plain)?.[0].length ?? 0;
			run = tail;
		}
		return run;
	};
}
