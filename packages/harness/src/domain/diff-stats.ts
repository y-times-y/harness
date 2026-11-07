type DiffLineCounts = {
	readonly additions: number;
	readonly deletions: number;
};

function emptyDiffLineCounts(): DiffLineCounts {
	return { additions: 0, deletions: 0 };
}

export function countDiffLineChanges(
	diff: string | null | undefined,
): DiffLineCounts {
	if (!diff) return emptyDiffLineCounts();
	let additions = 0;
	let deletions = 0;
	for (const line of diff.split("\n")) {
		if (
			line.startsWith("+++") ||
			line.startsWith("---") ||
			line.startsWith("\\")
		) {
			continue;
		}
		if (line.startsWith("+")) additions += 1;
		else if (line.startsWith("-")) deletions += 1;
	}
	return { additions, deletions };
}

function countWholeFileLines(diff: string | null | undefined): number {
	if (!diff) return 0;
	return diff.split("\n").filter((line) => line.length > 0).length;
}

export function isUnifiedDiff(diff: string | null | undefined): boolean {
	if (!diff) return false;
	return /^(?:--- |\+\+\+ |@@ )/m.test(diff);
}

export function countFileChangeLines(
	change: "add" | "delete" | "update",
	diff: string | null | undefined,
): DiffLineCounts {
	if (diff && isUnifiedDiff(diff)) return countDiffLineChanges(diff);
	const lines = countWholeFileLines(diff);
	if (change === "add") return { additions: lines, deletions: 0 };
	if (change === "delete") return { additions: 0, deletions: lines };
	return emptyDiffLineCounts();
}
