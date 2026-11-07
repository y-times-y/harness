/**
 * Git identity of a folder from the files under `.git` only (no `git` process): work
 * tree root, the common git directory shared by linked worktrees, the current branch
 * and the `origin` remote. Fast enough to run for every folder a session names.
 */
import fs from "node:fs";
import path from "node:path";
import { canonicalPath, findGitRoot } from "./io.ts";

export interface GitIdentity {
	/** Work tree root (for a linked worktree, the worktree's own root). */
	root: string;
	/** The repository's shared git directory; equal for a repo and all its worktrees. */
	commonDir: string;
	/** `origin` remote URL as configured. */
	remoteUrl?: string;
	/** `owner/name` for GitHub remotes, `host/path` for others. */
	remote?: string;
	/** Current branch; undefined when HEAD is detached. */
	branch?: string;
}

function readText(file: string): string | undefined {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

/** The git directory of a work tree root: `.git` itself, or where a `.git` file points. */
export function gitDirectoryOf(root: string): string | undefined {
	const dotGit = path.join(root, ".git");
	let stat: fs.Stats;
	try {
		stat = fs.statSync(dotGit);
	} catch {
		return undefined;
	}
	if (stat.isDirectory()) return dotGit;
	const match = /^gitdir:\s*(.+)$/m.exec(readText(dotGit) ?? "");
	return match?.[1] ? path.resolve(root, match[1].trim()) : undefined;
}

function commonDirectoryOf(gitDirectory: string): string {
	const pointer = readText(path.join(gitDirectory, "commondir"))?.trim();
	return pointer
		? canonicalPath(path.resolve(gitDirectory, pointer))
		: canonicalPath(gitDirectory);
}

/** `url` of `[remote "origin"]` in a git config file. */
export function originUrlFromConfig(config: string): string | undefined {
	let inOrigin = false;
	for (const raw of config.split(/\r?\n/)) {
		const line = raw.trim();
		if (line.startsWith("[")) {
			inOrigin = /^\[remote\s+"origin"\]$/.test(line);
			continue;
		}
		if (!inOrigin) continue;
		const match = /^url\s*=\s*(.+)$/.exec(line);
		if (match?.[1]) return match[1].trim();
	}
	return undefined;
}

/**
 * `owner/name` for GitHub remotes in any URL form (https, ssh, scp-like, with or
 * without `.git`); `host/path` for other hosts; undefined when it is not a URL.
 */
export function normalizeRemote(url: string | undefined): string | undefined {
	if (!url) return undefined;
	const trimmed = url.trim();
	let host: string | undefined;
	let repoPath: string | undefined;
	const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/\/)(.+)$/.exec(trimmed);
	if (scp && !/^[a-z]+:\/\//i.test(trimmed)) {
		host = scp[1];
		repoPath = scp[2];
	} else {
		try {
			const parsed = new URL(trimmed);
			host = parsed.hostname;
			repoPath = parsed.pathname;
		} catch {
			return undefined;
		}
	}
	if (!host || !repoPath) return undefined;
	const cleaned = repoPath
		.replace(/^\/+/, "")
		.replace(/\/+$/, "")
		.replace(/\.git$/, "");
	if (!cleaned) return undefined;
	if (host.toLowerCase() === "github.com" || host.endsWith(".github.com"))
		return cleaned.split("/").slice(0, 2).join("/");
	return `${host.toLowerCase()}/${cleaned}`;
}

function branchOf(gitDirectory: string): string | undefined {
	const head = readText(path.join(gitDirectory, "HEAD"))?.trim();
	const match = head ? /^ref:\s*refs\/heads\/(.+)$/.exec(head) : null;
	return match?.[1];
}

const identityCache = new Map<string, GitIdentity | null>();

/** Git identity of the work tree containing `folder`; undefined outside a repository. */
export function gitIdentity(folder: string): GitIdentity | undefined {
	const root = findGitRoot(folder);
	if (!root) return undefined;
	const cached = identityCache.get(root);
	if (cached !== undefined) return cached ?? undefined;
	const gitDirectory = gitDirectoryOf(root);
	if (!gitDirectory) {
		identityCache.set(root, null);
		return undefined;
	}
	const commonDir = commonDirectoryOf(gitDirectory);
	const remoteUrl = originUrlFromConfig(
		readText(path.join(commonDir, "config")) ?? "",
	);
	const identity: GitIdentity = {
		root,
		commonDir,
		remoteUrl,
		remote: normalizeRemote(remoteUrl),
		branch: branchOf(gitDirectory),
	};
	identityCache.set(root, identity);
	return identity;
}

/** For tests that rewrite repositories between cases. */
export function clearGitIdentityCache(): void {
	identityCache.clear();
}

/** Same repository: same common git directory, or the same normalized `origin`. */
export function sameRepository(
	a: GitIdentity | undefined,
	b: GitIdentity | undefined,
): boolean {
	if (!a || !b) return false;
	if (a.commonDir === b.commonDir) return true;
	return a.remote !== undefined && a.remote === b.remote;
}
