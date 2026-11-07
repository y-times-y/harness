import { z } from "zod";

export const projectSourceEvidence = z.object({
	revision: z
		.string()
		.regex(/^[a-f0-9]{40,64}$/)
		.nullable(),
	dirty: z.boolean(),
	sources: z
		.array(
			z.object({
				path: z.string().min(1).max(2048),
				sha256: z
					.string()
					.regex(/^[a-f0-9]{64}$/)
					.nullable(),
			}),
		)
		.max(8),
});
export type ProjectSourceEvidence = z.infer<typeof projectSourceEvidence>;

export function cachedSourceEvidence(document: string) {
	return [
		...document.matchAll(
			/<!-- ytimesy-knowledge:([a-z0-9-]+) -->([\s\S]*?)<!-- \/ytimesy-knowledge -->/g,
		),
	].flatMap((match) => {
		const encoded = /<!-- ytimesy-evidence:([^\n]*?) -->/.exec(match[2])?.[1];
		if (!encoded) return [];
		try {
			const evidence = projectSourceEvidence.safeParse(JSON.parse(encoded));
			return evidence.success
				? [{ key: match[1], evidence: evidence.data }]
				: [];
		} catch {
			return [];
		}
	});
}

/** Hash matches validate source freshness, not the agent's semantic or test claims. */
export function sourceEvidenceMatches(
	saved: ProjectSourceEvidence,
	current: ProjectSourceEvidence,
) {
	return (
		!saved.dirty &&
		!current.dirty &&
		sourceEvidenceContentsMatch(saved, current)
	);
}

/** Verification can run on intentional edits; every declared source must still match exactly. */
export function sourceEvidenceContentsMatch(
	saved: ProjectSourceEvidence,
	current: ProjectSourceEvidence,
) {
	return (
		saved.revision !== null &&
		saved.revision === current.revision &&
		sourceEvidenceFileHashesMatch(saved, current)
	);
}

/** A publication commit may change HEAD without changing the checked source bytes. */
export function sourceEvidenceFileHashesMatch(
	saved: ProjectSourceEvidence,
	current: ProjectSourceEvidence,
) {
	return (
		current.revision !== null &&
		saved.sources.length > 0 &&
		saved.sources.every(
			(source) =>
				source.sha256 !== null &&
				current.sources.some(
					(candidate) =>
						candidate.path === source.path &&
						candidate.sha256 === source.sha256,
				),
		)
	);
}
