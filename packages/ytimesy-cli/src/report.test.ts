import { describe, expect, it } from "vitest";
import {
	type DoneReport,
	megabytes,
	type PlanReport,
	renderDone,
	renderNeeds,
	renderPlan,
} from "./report.ts";

const branch: NonNullable<PlanReport["branch"]> = {
	repository: "acme/app",
	branch: "ytimesy/feature-login-3f9a",
	from: "feature-login",
	visibility: "private",
	trackedChanged: ["src/login.ts"],
	untrackedToPush: ["notes.md"],
	skipped: [{ path: ".env", reason: "secret-like name" }],
	wholeFolder: false,
};

const plan: PlanReport = {
	step: "plan",
	agent: { tool: "claude", name: "Claude Code" },
	session: {
		tool: "Claude Code",
		id: "0b9e",
		title: "Fix the login redirect",
		messages: 42,
		bytes: 1_234_567,
		folder: "~/code/app",
		pickedBecause: "the session running this command",
	},
	scope: "project",
	scopes: {
		session: { sessions: 1, bytes: 1_234_567, folders: 1 },
		project: { sessions: 3, bytes: 5_600_000, folders: 2 },
		machine: { sessions: 120, bytes: 410_000_000, folders: 18 },
	},
	groups: [
		{
			folder: "/Users/me/code/app",
			display: "~/code/app",
			continued: true,
			sessions: 2,
			bytes: 4_000_000,
			tools: ["claude", "codex"],
			action: "import",
			repository: "acme/app",
			visibility: "private",
			projectId: "p1",
			projectName: "app",
			decision: { kind: "import", projectName: "app" },
		},
		{
			folder: "/Users/me/scratch",
			display: "~/scratch",
			continued: false,
			sessions: 1,
			bytes: 1_600_000,
			tools: ["codex"],
			action: "no-repository",
			reason: "no-git",
			canCreateRepository: true,
			suggestedName: "scratch",
			attachTo: [{ id: "p1", name: "app" }],
			decision: null,
		},
		{
			folder: "/Users/me/code/lib",
			display: "~/code/lib",
			continued: false,
			sessions: 1,
			bytes: 30_000,
			tools: ["claude"],
			action: "grant-access",
			repository: "acme/lib",
			connectUrl: "https://github.com/apps/ytimesy/installations/new",
			decision: null,
		},
	],
	droppedGroups: 0,
	branch,
	secrets: { ".env": ["DATABASE_URL", "API_KEY"] },
	needs: [
		"~/scratch has no GitHub repository: --create-repo ~/scratch=scratch or --attach ~/scratch=<project id> or --skip ~/scratch",
	],
	next: "npx -y ytimesy continue --code YTM-ABCD-EFGH-JKLM --scope project --yes-untracked",
};

describe("renderPlan", () => {
	it("names a new project for a reachable repository and lists a plain folder's first commit", () => {
		const text = renderPlan({
			...plan,
			groups: [
				{
					...(plan.groups[0] as (typeof plan.groups)[number]),
					projectId: undefined,
					newProject: true,
					decision: { kind: "import", projectName: "app", newProject: true },
				},
			],
			branch: {
				...branch,
				repository: null,
				from: null,
				visibility: "new",
				trackedChanged: [],
				untrackedToPush: ["index.html", "src/main.js"],
				skipped: [{ path: "node_modules/", reason: "always left out" }],
				wholeFolder: true,
			},
		});
		expect(text).toContain('-> import (new project "app")');
		expect(text).toContain(
			"  the folder becomes the repository's first commit: 2 files\n    index.html\n    src/main.js\n  1 file skipped:\n    node_modules/ (always left out)",
		);
		const tooMany = renderPlan({
			...plan,
			branch: { ...branch, wholeFolder: true, tooManyFiles: 25_000 },
		});
		expect(tooMany).toContain("the folder has 25000 files");
	});

	it("prints scopes, folders with their actions, the branch, secrets and the next command", () => {
		expect(renderPlan(plan)).toBe(
			`ytimesy import plan (called from Claude Code)

This session: "Fix the login redirect" · Claude Code · 42 messages · 1.2 MB
  folder ~/code/app (the session running this command)

Scopes (pass one with --scope):
  session  1 session, 1.2 MB in 1 folder  (default)
  project  3 sessions, 5.6 MB in 2 folders  <- shown below
  machine  120 sessions, 410.0 MB in 18 folders

Folders in scope "project":
  ~/code/app (this session) · acme/app (private) · 2 sessions, 4.0 MB
    -> import into project "app"
  ~/scratch · 1 session, 1.6 MB
    -> not a Git repository: create a private repository, attach to a project, or skip
    options: --create-repo ~/scratch=scratch  |  --attach ~/scratch=<project id>  |  --skip ~/scratch
    projects: app (p1)
  ~/code/lib · acme/lib · 1 session, <0.1 MB
    -> give the ytimesy GitHub app access to acme/lib first: https://github.com/apps/ytimesy/installations/new

Branch ytimesy/feature-login-3f9a on acme/app, from feature-login (your checkout is not touched):
  1 uncommitted tracked change
    src/login.ts
  1 untracked file to push (needs --yes-untracked)
    notes.md
  1 file skipped:
    .env (secret-like name)

Secrets from .env (values never shown; uploaded only with --secrets): DATABASE_URL, API_KEY

Needs the user's decision:
  - ~/scratch has no GitHub repository: --create-repo ~/scratch=scratch or --attach ~/scratch=<project id> or --skip ~/scratch

Next: show this plan to the user and ask which scope to import. Then run:
  npx -y ytimesy continue --code YTM-ABCD-EFGH-JKLM --scope project --yes-untracked`,
		);
	});

	it("says when there are no secrets and a folder becomes a first commit", () => {
		const text = renderPlan({
			...plan,
			agent: null,
			groups: [],
			needs: [],
			secrets: {},
			branch: {
				...branch,
				repository: null,
				from: null,
				visibility: "new",
				wholeFolder: true,
				untrackedToPush: ["a", "b"],
			},
		});
		expect(text).toContain("ytimesy import plan\n");
		expect(text).toContain(
			"the folder becomes the repository's first commit: 2 files",
		);
		expect(text).toContain("Secrets: no .env or .env.local in this folder.");
		expect(text).not.toContain("Needs the user's decision");
	});
});

describe("renderNeeds and renderDone", () => {
	it("prints the decisions and the command to run", () => {
		expect(
			renderNeeds({
				step: "needs-decision",
				needs: ["pass --yes-untracked"],
				next: "npx -y ytimesy continue --code X --scope session",
			}),
		).toBe(`Not imported yet. Needs the user's decision:
  - pass --yes-untracked

Ask the user, then run:
  npx -y ytimesy continue --code X --scope session`);
	});

	it("ends with Done — open <url>", () => {
		const done: DoneReport = {
			step: "done",
			openUrl: "https://ytimesy.com/?project=p1&chat=c1",
			repository: "acme/app",
			branch: "ytimesy/feature-login-3f9a",
			pushed: ["src/login.ts", "notes.md"],
			skipped: [{ path: ".env", reason: "secret-like name" }],
			sessions: {
				uploaded: 2,
				alreadyUploaded: 1,
				failed: [],
				transcriptsMissing: [],
			},
			secrets: ["DATABASE_URL", "API_KEY"],
			createdRepositories: [
				{ folder: "~/scratch", repository: "acme/scratch" },
			],
			skippedFolders: [{ folder: "~/code/lib", reason: "skipped" }],
		};
		expect(renderDone(done)).toBe(
			`Branch ytimesy/feature-login-3f9a on acme/app: 2 files pushed, 1 skipped.
Pushed:
    src/login.ts
    notes.md
Skipped:
    .env (secret-like name)
Created private repository acme/scratch for ~/scratch.
Not imported: ~/code/lib (skipped).
Sessions: 2 imported, 1 already imported.
Secrets: DATABASE_URL, API_KEY saved to the project for review.

Done — open https://ytimesy.com/?project=p1&chat=c1`,
		);
	});

	it("formats sizes", () => {
		expect(megabytes(0)).toBe("0 MB");
		expect(megabytes(50_000)).toBe("<0.1 MB");
		expect(megabytes(2_345_678)).toBe("2.3 MB");
	});
});
