import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type Env,
	folderPlan,
	pushCommit,
	snapshotFolder,
	snapshotRepository,
} from "./repo-snapshot.ts";

let base: string;
let repo: string;
let remote: string;
let env: Env;

function run(cwd: string, ...args: string[]) {
	return execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
}

function write(root: string, name: string, content: string) {
	fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
	fs.writeFileSync(path.join(root, name), content);
}

/** Every byte the user could notice: work tree files, index, HEAD, refs, config. */
function fingerprint(root: string) {
	const files: Record<string, string> = {};
	const walk = (directory: string) => {
		for (const entry of fs
			.readdirSync(directory, { withFileTypes: true })
			.sort((a, b) => a.name.localeCompare(b.name))) {
			const full = path.join(directory, entry.name);
			const relative = path.relative(root, full);
			if (relative === ".git/objects" || relative === ".git/logs") continue;
			if (entry.isDirectory()) walk(full);
			else {
				const stat = fs.lstatSync(full);
				files[relative] = createHash("sha256")
					.update(`${stat.mode}\0${stat.mtimeMs}\0`)
					.update(fs.readFileSync(full))
					.digest("hex");
			}
		}
	};
	walk(root);
	return files;
}

beforeEach(() => {
	base = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "ytimesy-snapshot-")),
	);
	fs.writeFileSync(
		path.join(base, "gitconfig"),
		"[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n",
	);
	env = {
		PATH: process.env.PATH,
		HOME: base,
		GIT_CONFIG_GLOBAL: path.join(base, "gitconfig"),
		GIT_CONFIG_NOSYSTEM: "1",
	};
	repo = path.join(base, "repo");
	remote = path.join(base, "remote.git");
	fs.mkdirSync(repo);
	run(base, "init", "--bare", "--quiet", remote);
	run(repo, "init", "--quiet");
	write(repo, "README.md", "hello\n");
	write(repo, "src/app.ts", "export const a = 1;\n");
	write(repo, "src/old.ts", "old\n");
	write(repo, ".gitignore", "dist/\n");
	run(repo, "add", ".");
	run(repo, "commit", "--quiet", "-m", "first");
	run(repo, "remote", "add", "origin", remote);
	run(repo, "push", "--quiet", "origin", "main");
});

afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

describe("snapshotRepository", () => {
	it("commits staged, unstaged, deleted and allowed untracked files without touching the checkout", () => {
		write(repo, "src/app.ts", "export const a = 2;\n");
		write(repo, "README.md", "hello, staged\n");
		run(repo, "add", "README.md");
		write(repo, "staged-new.ts", "new and staged\n");
		run(repo, "add", "staged-new.ts");
		fs.rmSync(path.join(repo, "src/old.ts"));
		write(repo, "notes.md", "untracked notes\n");
		write(repo, ".env", "SECRET=abc\n");
		write(repo, "leak.txt", "AKIAABCDEFGHIJKLMNOP\n");
		write(repo, "dist/out.js", "ignored\n");
		const statusBefore = run(repo, "status", "--porcelain=v2", "--branch");
		const before = fingerprint(repo);
		const head = run(repo, "rev-parse", "HEAD");

		const snapshot = snapshotRepository({
			root: repo,
			env,
			message: "handoff",
			includeUntracked: true,
		});
		pushCommit({
			cwd: repo,
			env,
			remote: "origin",
			sha: snapshot.sha,
			branch: "ytimesy/test-1",
		});

		expect(fingerprint(repo)).toEqual(before);
		expect(run(repo, "status", "--porcelain=v2", "--branch")).toBe(
			statusBefore,
		);
		expect(run(repo, "rev-parse", "HEAD")).toBe(head);
		expect(run(repo, "symbolic-ref", "HEAD")).toBe("refs/heads/main");

		expect(snapshot.changed).toBe(true);
		expect(snapshot.base).toBe(head);
		expect([...snapshot.trackedChanged].sort()).toEqual([
			"README.md",
			"src/app.ts",
			"src/old.ts",
			"staged-new.ts",
		]);
		expect(snapshot.untrackedPushed).toEqual(["notes.md"]);
		expect(snapshot.skipped.map((file) => [file.path, file.reason])).toEqual([
			[".env", "secret-like name"],
			["leak.txt", "contains an AWS key (AKIA…)"],
		]);
		const files = run(
			remote,
			"ls-tree",
			"-r",
			"--name-only",
			"refs/heads/ytimesy/test-1",
		).split("\n");
		expect(files.sort()).toEqual([
			".gitignore",
			"README.md",
			"notes.md",
			"src/app.ts",
			"staged-new.ts",
		]);
		expect(run(remote, "show", "refs/heads/ytimesy/test-1:src/app.ts")).toBe(
			"export const a = 2;",
		);
		expect(run(remote, "rev-parse", "refs/heads/ytimesy/test-1^")).toBe(head);
		expect(run(remote, "rev-parse", "refs/heads/main")).toBe(head);
	});

	it("pushes HEAD itself when nothing changed, and leaves untracked files out on request", () => {
		write(repo, "notes.md", "untracked\n");
		const head = run(repo, "rev-parse", "HEAD");
		const snapshot = snapshotRepository({
			root: repo,
			env,
			message: "handoff",
			includeUntracked: false,
		});
		expect(snapshot).toMatchObject({ sha: head, changed: false });
		expect(snapshot.untrackedPushed).toEqual([]);
	});

	it("replaces its own earlier push with a lease", () => {
		write(repo, "a.txt", "one\n");
		const first = snapshotRepository({
			root: repo,
			env,
			message: "one",
			includeUntracked: true,
		});
		pushCommit({
			cwd: repo,
			env,
			remote: "origin",
			sha: first.sha,
			branch: "ytimesy/x",
		});
		write(repo, "a.txt", "two\n");
		const second = snapshotRepository({
			root: repo,
			env,
			message: "two",
			includeUntracked: true,
		});
		pushCommit({
			cwd: repo,
			env,
			remote: "origin",
			sha: second.sha,
			branch: "ytimesy/x",
			lease: first.sha,
		});
		expect(run(remote, "rev-parse", "refs/heads/ytimesy/x")).toBe(second.sha);
		expect(() =>
			pushCommit({
				cwd: repo,
				env,
				remote: "origin",
				sha: first.sha,
				branch: "ytimesy/x",
				lease: first.sha,
			}),
		).toThrow(/push/);
	});

	it("works in a repository without commits", () => {
		const empty = path.join(base, "empty");
		fs.mkdirSync(empty);
		run(empty, "init", "--quiet");
		write(empty, "first.ts", "x\n");
		const before = fingerprint(empty);
		const snapshot = snapshotRepository({
			root: empty,
			env,
			message: "handoff",
			includeUntracked: true,
		});
		expect(snapshot.base).toBeNull();
		expect(run(empty, "ls-tree", "--name-only", snapshot.sha)).toBe("first.ts");
		expect(fingerprint(empty)).toEqual(before);
	});
});

describe("snapshotFolder", () => {
	it("commits a plain folder from a temporary Git directory", () => {
		const folder = path.join(base, "plain");
		write(folder, "index.html", "<h1>hi</h1>\n");
		write(folder, "node_modules/x/index.js", "dep\n");
		write(folder, "build/out.txt", "ignored by .gitignore\n");
		write(folder, ".gitignore", "build/\n");
		write(folder, ".env", "A=1\n");
		const before = fingerprint(folder);
		const snapshot = snapshotFolder({ folder, env, message: "Initial import" });
		try {
			expect([...snapshot.pushed].sort()).toEqual([".gitignore", "index.html"]);
			expect(snapshot.skipped.map((file) => file.path)).toEqual([".env"]);
			pushCommit({
				cwd: folder,
				env: snapshot.env,
				remote,
				sha: snapshot.sha,
				branch: "imported",
			});
		} finally {
			fs.rmSync(snapshot.gitDir, { recursive: true, force: true });
		}
		expect(fs.existsSync(path.join(folder, ".git"))).toBe(false);
		expect(fingerprint(folder)).toEqual(before);
		expect(
			run(remote, "ls-tree", "-r", "--name-only", "refs/heads/imported")
				.split("\n")
				.sort(),
		).toEqual([".gitignore", "index.html"]);
	});
});

describe("folderPlan", () => {
	it("previews exactly what snapshotFolder pushes, and what it leaves out and why", () => {
		const folder = path.join(base, "plain-preview");
		write(folder, "index.html", "<h1>hi</h1>\n");
		write(folder, "src/app.js", "console.log(1);\n");
		write(folder, "node_modules/x/index.js", "dep\n");
		write(folder, "build/out.txt", "ignored by .gitignore\n");
		write(folder, ".gitignore", "build/\n");
		write(folder, ".env", "A=1\n");
		write(folder, "notes.txt", `token ghp_${"a".repeat(36)}\n`);
		const before = fingerprint(folder);
		const plan = folderPlan(folder, env);
		expect(plan.tooMany).toBe(false);
		expect(plan.included.map((file) => file.path).sort()).toEqual([
			".gitignore",
			"index.html",
			"src/app.js",
		]);
		expect(
			[...plan.skipped].sort((a, b) => a.path.localeCompare(b.path)),
		).toEqual([
			{ path: ".env", reason: "secret-like name" },
			{ path: "build/", reason: "ignored by .gitignore" },
			{ path: "node_modules/", reason: "always left out" },
			{ path: "notes.txt", reason: "contains a GitHub token (ghp_…)" },
		]);
		// The preview writes nothing into the folder.
		expect(fingerprint(folder)).toEqual(before);
		const snapshot = snapshotFolder({ folder, env, message: "Initial import" });
		try {
			expect([...snapshot.pushed].sort()).toEqual(
				plan.included.map((file) => file.path).sort(),
			);
		} finally {
			fs.rmSync(snapshot.gitDir, { recursive: true, force: true });
		}
	});
});

it("sees an edit made in the same second as the last index write (racily clean)", () => {
	// Same size, same mtime as the indexed entry, index written that second:
	// only git's racy-entry check notices, and it needs the index's own mtime.
	run(repo, "config", "core.trustctime", "false");
	const file = path.join(repo, "src/app.ts");
	const second = new Date("2026-01-01T00:00:00Z");
	fs.utimesSync(file, second, second);
	run(repo, "add", "src/app.ts");
	const index = path.join(repo, ".git", "index");
	fs.utimesSync(index, second, second);
	fs.writeFileSync(file, "export const a = 2;\n");
	fs.utimesSync(file, second, second);
	const snapshot = snapshotRepository({
		root: repo,
		env,
		message: "snapshot",
		includeUntracked: false,
	});
	expect(snapshot.changed).toBe(true);
	expect(run(repo, "show", `${snapshot.sha}:src/app.ts`)).toBe(
		"export const a = 2;",
	);
});
