import fs from "node:fs";
import path from "node:path";

/**
 * Which untracked files may go on the pushed branch: under 5 MB, a name that
 * does not look like a secret, and content without key material. Every
 * skipped file carries the reason the CLI prints.
 */

export const UNTRACKED_MAX_BYTES = 5 * 1024 * 1024;

const SECRET_NAMES: readonly RegExp[] = [
	/^\.env/i,
	/\.pem$/i,
	/\.key$/i,
	/^id_rsa/i,
	/\.p12$/i,
	/^credentials.*\.json$/i,
	/^service-account.*\.json$/i,
];

const KEY_PATTERNS: readonly [RegExp, string][] = [
	[/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/, "contains a private key"],
	[/(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/, "contains an API key (sk-…)"],
	[/(?<![A-Za-z0-9])ghp_[A-Za-z0-9]{30,}/, "contains a GitHub token (ghp_…)"],
	[/github_pat_[A-Za-z0-9_]{20,}/, "contains a GitHub token (github_pat_…)"],
	[/(?<![A-Z0-9])AKIA[0-9A-Z]{16}(?![A-Z0-9])/, "contains an AWS key (AKIA…)"],
	[/(?<![A-Za-z0-9])xox[bap]-[A-Za-z0-9-]{10,}/, "contains a Slack token"],
];

export type FileVerdict =
	| { readonly path: string; readonly include: true; readonly bytes: number }
	| {
			readonly path: string;
			readonly include: false;
			readonly bytes: number;
			readonly reason: string;
	  };

/** Whether a file name looks like a secret (.env*, *.pem, id_rsa*, ...). */
export function secretLikeName(file: string): boolean {
	const base = path.basename(file);
	return SECRET_NAMES.some((pattern) => pattern.test(base));
}

/** The first key pattern found in the text, as a reason, or null. */
export function keyMaterialReason(text: string): string | null {
	for (const [pattern, reason] of KEY_PATTERNS)
		if (pattern.test(text)) return reason;
	return null;
}

/** Whether `relativePath` (inside `root`) may be pushed, and why not. */
export function checkUntrackedFile(
	root: string,
	relativePath: string,
): FileVerdict {
	const absolute = path.join(root, relativePath);
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(absolute);
	} catch {
		return {
			path: relativePath,
			include: false,
			bytes: 0,
			reason: "could not be read",
		};
	}
	const bytes = stat.size;
	if (secretLikeName(relativePath))
		return {
			path: relativePath,
			include: false,
			bytes,
			reason: "secret-like name",
		};
	// A symlink is stored as its target path; nothing behind it is pushed.
	if (stat.isSymbolicLink())
		return { path: relativePath, include: true, bytes };
	if (!stat.isFile())
		return {
			path: relativePath,
			include: false,
			bytes,
			reason: "not a regular file",
		};
	if (bytes >= UNTRACKED_MAX_BYTES)
		return {
			path: relativePath,
			include: false,
			bytes,
			reason: "larger than 5 MB",
		};
	let text: string;
	try {
		text = fs.readFileSync(absolute).toString("latin1");
	} catch {
		return {
			path: relativePath,
			include: false,
			bytes,
			reason: "could not be read",
		};
	}
	const reason = keyMaterialReason(text);
	return reason
		? { path: relativePath, include: false, bytes, reason }
		: { path: relativePath, include: true, bytes };
}

export function filterUntrackedFiles(root: string, files: readonly string[]) {
	const verdicts = files.map((file) => checkUntrackedFile(root, file));
	return {
		included: verdicts.filter((verdict) => verdict.include),
		skipped: verdicts.filter(
			(verdict): verdict is Extract<FileVerdict, { include: false }> =>
				!verdict.include,
		),
	};
}
