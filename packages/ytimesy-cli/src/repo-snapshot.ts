import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type FileVerdict, filterUntrackedFiles } from "./untracked.ts";

/**
 * Commits of the user's work made without touching their working tree, index
 * or current branch: a temporary index (GIT_INDEX_FILE) seeded from theirs,
 * `git add` of tracked changes and allowed untracked files into it, then
 * write-tree and commit-tree. Only new objects land in .git/objects. Pushes
 * use the user's own Git credentials.
 */

export type Env = Record<string, string | undefined>;

const PUSH_TIMEOUT_MS = 5 * 60_000;

export class GitError extends Error {
	constructor(
		message: string,
		readonly stderr: string,
	) {
		super(message);
	}
}

export function git(
	args: readonly string[],
	options: {
		readonly cwd: string;
		readonly env: Env;
		readonly input?: string;
		readonly timeout?: number;
	},
): string {
	try {
		return execFileSync("git", ["-c", "gc.auto=0", ...args], {
			cwd: options.cwd,
			env: {
				...options.env,
				GIT_TERMINAL_PROMPT: "0",
				GIT_OPTIONAL_LOCKS: "0",
			} as NodeJS.ProcessEnv,
			input: options.input,
			encoding: "utf8",
			maxBuffer: 256 * 1024 * 1024,
			timeout: options.timeout ?? 60_000,
			stdio: ["pipe", "pipe", "pipe"],
		});
	} catch (error) {
		const failure = error as { stderr?: string | Buffer; message: string };
		const stderr = String(failure.stderr ?? "").trim();
		throw new GitError(
			`git ${args[0]} failed: ${stderr.split("\n").slice(-3).join(" ") || failure.message}`,
			stderr,
		);
	}
}

function tryGit(args: readonly string[], options: Parameters<typeof git>[1]) {
	try {
		return git(args, options).trim();
	} catch {
		return null;
	}
}

/** Untracked files git would not ignore, relative to the work tree root. */
export function untrackedFiles(root: string, env: Env) {
	return git(["ls-files", "--others", "--exclude-standard", "-z"], {
		cwd: root,
		env,
	})
		.split("\0")
		.filter(Boolean);
}

/** Tracked files that differ from HEAD (staged or not), for the plan's count. */
export function changedTrackedFiles(root: string, env: Env) {
	const head = tryGit(["rev-parse", "-q", "--verify", "HEAD^{commit}"], {
		cwd: root,
		env,
	});
	if (!head) return [];
	return git(["diff", "--name-only", "-z", "HEAD"], { cwd: root, env })
		.split("\0")
		.filter(Boolean);
}

/** The untracked files the branch would carry, and those skipped with a reason. */
export function untrackedPlan(root: string, env: Env) {
	return filterUntrackedFiles(root, untrackedFiles(root, env));
}

/** Author and committer for commit-tree when the user has no identity configured. */
function identityEnv(cwd: string, env: Env): Env {
	const name = tryGit(["config", "user.name"], { cwd, env });
	const email = tryGit(["config", "user.email"], { cwd, env });
	return {
		...(name || env.GIT_AUTHOR_NAME
			? {}
			: { GIT_AUTHOR_NAME: "ytimesy", GIT_COMMITTER_NAME: "ytimesy" }),
		...(email || env.GIT_AUTHOR_EMAIL
			? {}
			: {
					GIT_AUTHOR_EMAIL: "noreply@ytimesy.com",
					GIT_COMMITTER_EMAIL: "noreply@ytimesy.com",
				}),
	};
}

function addFiles(files: readonly string[], cwd: string, env: Env) {
	if (!files.length) return;
	git(["add", "--pathspec-from-file=-", "--pathspec-file-nul", "--"], {
		cwd,
		env: { ...env, GIT_LITERAL_PATHSPECS: "1" },
		input: `${files.join("\0")}\0`,
	});
}

export type Snapshot = {
	/** The commit to push. */
	readonly sha: string;
	/** HEAD when the snapshot was made, or null in a repository without commits. */
	readonly base: string | null;
	/** False when the work equals HEAD (then sha is HEAD itself). */
	readonly changed: boolean;
	readonly trackedChanged: readonly string[];
	readonly untrackedPushed: readonly string[];
	readonly skipped: readonly Extract<FileVerdict, { include: false }>[];
};

/**
 * A commit of the work tree at `root`: HEAD plus uncommitted tracked changes
 * (staged or not) plus the given untracked files, made in a temporary index.
 * The user's working tree, index and HEAD are left exactly as they were.
 */
export function snapshotWorkTree(input: {
	readonly root: string;
	readonly env: Env;
	readonly untracked: readonly string[];
	readonly message: string;
}): Omit<Snapshot, "skipped" | "untrackedPushed"> {
	const { root, env } = input;
	const realIndex = path.resolve(
		root,
		git(["rev-parse", "--git-path", "index"], { cwd: root, env }).trim(),
	);
	const head = tryGit(["rev-parse", "-q", "--verify", "HEAD^{commit}"], {
		cwd: root,
		env,
	});
	const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ytimesy-index-"));
	try {
		const indexFile = path.join(temporary, "index");
		const indexed = { ...env, GIT_INDEX_FILE: indexFile };
		if (fs.existsSync(realIndex)) {
			fs.copyFileSync(realIndex, indexFile);
			// Git re-reads a file whose mtime is not older than the index's
			// ("racily clean"): a fresh mtime on the copy would hide an edit made
			// in the same second as the last index write, with the same size.
			const stat = fs.statSync(realIndex);
			fs.utimesSync(indexFile, stat.atimeMs / 1000, stat.mtimeMs / 1000);
		} else if (head) git(["read-tree", head], { cwd: root, env: indexed });
		const trackedChanged = head ? changedTrackedFiles(root, env) : [];
		git(["add", "--update"], { cwd: root, env: indexed });
		addFiles(input.untracked, root, indexed);
		const tree = git(["write-tree"], { cwd: root, env: indexed }).trim();
		if (head) {
			const headTree = git(["rev-parse", `${head}^{tree}`], {
				cwd: root,
				env,
			}).trim();
			if (headTree === tree)
				return { sha: head, base: head, changed: false, trackedChanged };
		}
		const sha = git(
			["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", input.message],
			{ cwd: root, env: { ...env, ...identityEnv(root, env) } },
		).trim();
		return { sha, base: head, changed: true, trackedChanged };
	} finally {
		fs.rmSync(temporary, { recursive: true, force: true });
	}
}

/** The work tree snapshot with the untracked-file rules applied. */
export function snapshotRepository(input: {
	readonly root: string;
	readonly env: Env;
	readonly message: string;
	readonly includeUntracked: boolean;
}): Snapshot {
	const { included, skipped } = untrackedPlan(input.root, input.env);
	const untracked = input.includeUntracked
		? included.map((file) => file.path)
		: [];
	const snapshot = snapshotWorkTree({
		root: input.root,
		env: input.env,
		untracked,
		message: input.message,
	});
	return { ...snapshot, untrackedPushed: untracked, skipped };
}

/** Folders never pushed from a folder that is not a Git repository. */
export const FOLDER_IGNORES = [
	".git",
	"node_modules",
	".venv",
	"venv",
	"__pycache__",
	".next",
	".nuxt",
	".turbo",
	".cache",
	".DS_Store",
];
export const FOLDER_MAX_FILES = 20_000;

/** A temporary Git directory whose work tree is `folder` (the folder itself is never written). */
function folderGit(folder: string, env: Env) {
	const gitDir = fs.mkdtempSync(path.join(os.tmpdir(), "ytimesy-folder-"));
	const gitEnv: Env = {
		...env,
		GIT_DIR: gitDir,
		GIT_WORK_TREE: folder,
		GIT_INDEX_FILE: path.join(gitDir, "ytimesy-index"),
	};
	try {
		git(["init", "--quiet"], { cwd: folder, env: gitEnv });
	} catch (error) {
		fs.rmSync(gitDir, { recursive: true, force: true });
		throw error;
	}
	return { gitDir, env: gitEnv };
}

const FOLDER_EXCLUDES = FOLDER_IGNORES.flatMap((name) => ["--exclude", name]);

function listFolder(folder: string, env: Env) {
	return git(
		["ls-files", "--others", "--exclude-standard", "-z", ...FOLDER_EXCLUDES],
		{ cwd: folder, env },
	)
		.split("\0")
		.filter(Boolean);
}

export type FolderPlan = {
	/** Files the first commit carries (when not too many). */
	readonly included: readonly Extract<FileVerdict, { include: true }>[];
	/** Files and folders left out, each with its reason. */
	readonly skipped: readonly { path: string; reason: string }[];
	/** Files git would add before the filters; over FOLDER_MAX_FILES nothing is pushed. */
	readonly listed: number;
	readonly tooMany: boolean;
};

/**
 * What snapshotFolder would push from a folder that is not a Git
 * repository, by the same rules (its .gitignore, FOLDER_IGNORES, the
 * untracked-file filters, the FOLDER_MAX_FILES cap), with nothing committed:
 * the plan's preview. Ignored folders are listed once each, not file by file.
 */
export function folderPlan(folder: string, env: Env): FolderPlan {
	const { gitDir, env: gitEnv } = folderGit(folder, env);
	try {
		const listed = listFolder(folder, gitEnv);
		const ignored = git(
			[
				"ls-files",
				"--others",
				"--ignored",
				"--exclude-standard",
				"--directory",
				"-z",
				...FOLDER_EXCLUDES,
			],
			{ cwd: folder, env: gitEnv },
		)
			.split("\0")
			.filter(Boolean)
			.map((entry) => ({
				path: entry,
				reason: FOLDER_IGNORES.includes(path.basename(entry.replace(/\/$/, "")))
					? "always left out"
					: "ignored by .gitignore",
			}));
		if (listed.length > FOLDER_MAX_FILES)
			return {
				included: [],
				skipped: ignored,
				listed: listed.length,
				tooMany: true,
			};
		const { included, skipped } = filterUntrackedFiles(folder, listed);
		return {
			included,
			skipped: [
				...skipped.map((file) => ({ path: file.path, reason: file.reason })),
				...ignored,
			],
			listed: listed.length,
			tooMany: false,
		};
	} finally {
		fs.rmSync(gitDir, { recursive: true, force: true });
	}
}

export function tooManyFiles(folder: string, count: number) {
	return `${folder} has ${count} files (more than ${FOLDER_MAX_FILES}). Add a .gitignore for build output and dependencies, or skip it.`;
}

/**
 * A folder that is not a Git repository, as one initial commit in a
 * temporary Git directory (the folder itself is never written). Its
 * .gitignore is honored, plus FOLDER_IGNORES and the untracked-file rules.
 * Returns the temporary Git directory to push from; remove it afterwards.
 */
export function snapshotFolder(input: {
	readonly folder: string;
	readonly env: Env;
	readonly message: string;
}) {
	const { gitDir, env } = folderGit(input.folder, input.env);
	try {
		const listed = listFolder(input.folder, env);
		if (listed.length > FOLDER_MAX_FILES)
			throw new Error(tooManyFiles(input.folder, listed.length));
		const { included, skipped } = filterUntrackedFiles(input.folder, listed);
		const files = included.map((file) => file.path);
		if (!files.length) throw new Error(`${input.folder} has no files to push.`);
		addFiles(files, input.folder, env);
		const tree = git(["write-tree"], { cwd: input.folder, env }).trim();
		const sha = git(["commit-tree", tree, "-m", input.message], {
			cwd: input.folder,
			env: { ...env, ...identityEnv(input.folder, env) },
		}).trim();
		return { gitDir, env, sha, pushed: files, skipped };
	} catch (error) {
		fs.rmSync(gitDir, { recursive: true, force: true });
		throw error;
	}
}

/** The commit a remote branch points at, or null when it does not exist. */
export function remoteBranchSha(
	cwd: string,
	env: Env,
	remote: string,
	branch: string,
) {
	const line = git(["ls-remote", "--heads", remote, `refs/heads/${branch}`], {
		cwd,
		env,
		timeout: PUSH_TIMEOUT_MS,
	}).trim();
	return line ? (line.split(/\s+/)[0] ?? null) : null;
}

/**
 * Pushes a commit to `refs/heads/<branch>` of `remote` (a remote name or URL)
 * with the user's credentials. `lease` replaces a branch this import pushed
 * before, only if it still points where we left it.
 */
export function pushCommit(input: {
	readonly cwd: string;
	readonly env: Env;
	readonly remote: string;
	readonly sha: string;
	readonly branch: string;
	readonly lease?: string;
}) {
	const ref = `refs/heads/${input.branch}`;
	// A remote name is pushed to by its URL, so no remote-tracking ref is written.
	const remote = /^[\w.-]+$/.test(input.remote)
		? git(["remote", "get-url", "--push", input.remote], {
				cwd: input.cwd,
				env: input.env,
			}).trim()
		: input.remote;
	git(
		[
			"push",
			"--quiet",
			...(input.lease ? [`--force-with-lease=${ref}:${input.lease}`] : []),
			remote,
			`${input.sha}:${ref}`,
		],
		{ cwd: input.cwd, env: input.env, timeout: PUSH_TIMEOUT_MS },
	);
}

/** The current branch name, or null when HEAD is detached. */
export function currentBranch(root: string, env: Env) {
	return tryGit(["symbolic-ref", "--quiet", "--short", "HEAD"], {
		cwd: root,
		env,
	});
}

/**
 * `previous` when it holds the same tree on the same parent as `next`: a
 * re-run reuses the commit it pushed instead of replacing it with a copy.
 */
export function sameCommitContent(
	root: string,
	env: Env,
	previous: string,
	next: string,
) {
	const shape = (sha: string) =>
		tryGit(["rev-parse", `${sha}^{tree}`, `${sha}^@`], { cwd: root, env });
	const before = shape(previous);
	return before !== null && before === shape(next);
}

export function headCommit(root: string, env: Env) {
	return tryGit(["rev-parse", "-q", "--verify", "HEAD^{commit}"], {
		cwd: root,
		env,
	});
}
