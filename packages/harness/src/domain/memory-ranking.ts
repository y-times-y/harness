import type { MemoryLine } from "./memory-repo";

/**
 * The read hook's ranking, pure: embedding similarity merged with a
 * BM25-style lexical score over each line's text and topic file, then a
 * small boost for lines that share a file with the strongest hits (a topic
 * file holds a decision and its later changes together).
 */

/** Words that carry no topic: English function words and request filler. */
const STOPWORDS = new Set(
	`a an and are as at be but by can could do does for from has have how i if in into is it its just let me my no not of on or our please should so than that the their them then there these this those to too up us was we were what when where which while who will with would you your yes also make add new use using used want need able get got way like same other`.split(
		" ",
	),
);

/**
 * A light English stemmer: enough to match "installs"/"install",
 * "tests"/"test", and short plurals ("IDs"/"id", "keys"/"key"), which a
 * request often names in the singular ("its id").
 */
function stem(word: string) {
	if (word.length <= 4)
		return word.length >= 3 && /[^su]s$/.test(word) && !word.endsWith("is")
			? word.slice(0, -1)
			: word;
	for (const suffix of ["ing", "ed", "es", "s"])
		if (word.endsWith(suffix) && word.length - suffix.length >= 4)
			return word.slice(0, -suffix.length);
	return word;
}

/** Lowercased word stems; `config.py` also yields `config` and `py`, `legacy/` yields `legacy`. */
export function memoryTokens(text: string): string[] {
	const out: string[] = [];
	for (const raw of text.toLowerCase().match(/[a-z0-9][a-z0-9_]*/g) ?? []) {
		if (STOPWORDS.has(raw) || raw.length < 2) continue;
		out.push(stem(raw));
		if (raw.includes("_"))
			for (const part of raw.split("_"))
				if (part.length >= 2 && !STOPWORDS.has(part)) out.push(stem(part));
	}
	return out;
}

/** What a line is indexed by: its topic name (no folder, no .md) and its text. */
export function memoryLineSearchText(entry: Pick<MemoryLine, "path" | "text">) {
	return `${(entry.path.split("/").pop() ?? entry.path).replace(/\.md$/, "")} ${entry.text}`;
}

const BM25_K1 = 1.2;
const BM25_B = 0.75;

/**
 * BM25 of each line against the query, over every line given (so rare words
 * weigh more). Repeated query words count once.
 */
export function lexicalScores<T extends Pick<MemoryLine, "path" | "text">>(
	lines: readonly T[],
	query: string,
): Map<T, number> {
	const terms = [...new Set(memoryTokens(query))];
	const docs = lines.map((entry) => memoryTokens(memoryLineSearchText(entry)));
	const average =
		docs.reduce((total, doc) => total + doc.length, 0) /
		Math.max(1, docs.length);
	const frequency = new Map<string, number>();
	for (const doc of docs)
		for (const term of new Set(doc))
			frequency.set(term, (frequency.get(term) ?? 0) + 1);
	const scores = new Map<T, number>();
	lines.forEach((entry, index) => {
		const doc = docs[index];
		let score = 0;
		for (const term of terms) {
			const count = doc.filter((token) => token === term).length;
			if (!count) continue;
			const df = frequency.get(term) ?? 0;
			const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
			score +=
				(idf * count * (BM25_K1 + 1)) /
				(count +
					BM25_K1 * (1 - BM25_B + (BM25_B * doc.length) / (average || 1)));
		}
		scores.set(entry, score);
	});
	return scores;
}

export type HybridWeights = {
	/** Weight of the lexical part, which saturates at 1: bm25 / (bm25 + half). */
	lexical: number;
	/** BM25 at which the lexical part is half its weight. */
	half: number;
	/** Share of the best line score in its file added to every line of that file. */
	file: number;
	/**
	 * The file boost applies only when its file's best line scores at least
	 * this: a weak best hit is not evidence its neighbours matter.
	 */
	strong: number;
};

/**
 * Set on the long-history eval's --recall-check (two run snapshots, 26
 * probes) and checked on the two-chat eval's --recall (10 probes), Qwen3-
 * Embedding 0.6B, 2026-10-17: with the top 8 kept, the right line was
 * selected for 23/26 long-history probes (cosine alone: 16/26) and 9/10
 * two-chat probes (unchanged). Lexical 0.2-0.3 with file 0.25-0.3 scored
 * the same; the middle of that range is used.
 */
export const HYBRID_WEIGHTS: HybridWeights = {
	lexical: 0.24,
	half: 4,
	file: 0.25,
	strong: 0.5,
};

/**
 * cosine + lexical, then each line gains `file` x how far the best other
 * line of its topic file scores above it, when that line is a strong hit
 * (`strong`): a decision's later change usually sits in the same file.
 */
export function hybridScores<T extends Pick<MemoryLine, "path" | "text">>(
	lines: readonly T[],
	similarity: ReadonlyMap<T, number>,
	lexical: ReadonlyMap<T, number>,
	weights: HybridWeights = HYBRID_WEIGHTS,
): Map<T, number> {
	const base = new Map(
		lines.map((entry) => {
			const bm25 = lexical.get(entry) ?? 0;
			return [
				entry,
				(similarity.get(entry) ?? 0) +
					weights.lexical * (bm25 / (bm25 + weights.half)),
			] as const;
		}),
	);
	const best = new Map<string, [number, number]>();
	for (const [entry, score] of base) {
		const [first, second] = best.get(entry.path) ?? [0, 0];
		best.set(
			entry.path,
			score > first ? [score, first] : [first, Math.max(second, score)],
		);
	}
	return new Map(
		[...base].map(([entry, score]) => {
			const [first, second] = best.get(entry.path) ?? [0, 0];
			const neighbour = score >= first ? second : first;
			if (neighbour < weights.strong) return [entry, score];
			return [entry, score + weights.file * Math.max(0, neighbour - score)];
		}),
	);
}

/** The read hook's score for every line: hybrid of `similarity` (cosine to the query) and BM25. */
export function memoryMatchScores<T extends Pick<MemoryLine, "path" | "text">>(
	lines: readonly T[],
	similarity: ReadonlyMap<T, number>,
	query: string,
) {
	return hybridScores(lines, similarity, lexicalScores(lines, query));
}
