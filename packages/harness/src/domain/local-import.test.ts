import { describe, expect, it } from "vitest";
import {
	bearerImportToken,
	draftEnvironmentRecipe,
	finishRequest,
	HANDOFF_DIRECTORY,
	type HandoffDocument,
	handoffBranch,
	handoffContextText,
	handoffDocument,
	handoffFolderName,
	handoffIndexMarkdown,
	importCodeRefusal,
	importedSecretValues,
	importSecretHash,
	importTokenUsable,
	LOCAL_IMPORT_LIMITS,
	localImportViewStatus,
	looksGzipped,
	newImportCode,
	newImportToken,
	normalizeImportCode,
	type PlanGroup,
	planLocalImport,
	planRequest,
	secretsRequest,
	sessionUploadRequest,
	startRequest,
} from "./local-import";
import {
	handoffCardLabel,
	localImportSettled,
	localImportStatusLine,
} from "./local-import-view";

const now = new Date("2026-11-01T12:00:00Z");
const minutes = (count: number) => new Date(now.getTime() + count * 60_000);

describe("import codes", () => {
	it("are YTM-XXXX-XXXX-XXXX from an unambiguous alphabet", () => {
		for (let index = 0; index < 50; index++)
			expect(newImportCode()).toMatch(
				/^YTM-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/,
			);
		expect(newImportCode(() => new Uint8Array(12))).toBe("YTM-AAAA-AAAA-AAAA");
	});

	it("are accepted as typed or pasted, and nothing else", () => {
		const code = newImportCode();
		expect(normalizeImportCode(code)).toBe(code);
		expect(normalizeImportCode(` ${code.toLowerCase()} `)).toBe(code);
		expect(normalizeImportCode(code.replace(/-/g, ""))).toBe(code);
		expect(normalizeImportCode(code.slice(4))).toBe(code);
		expect(normalizeImportCode("YTM-AAAA-AAAA-AAA0")).toBeNull();
		expect(normalizeImportCode("YTM-AAAA-AAAA-AAAI")).toBeNull();
		expect(normalizeImportCode("YTM-AAAA-AAAA")).toBeNull();
		expect(normalizeImportCode("")).toBeNull();
	});

	it("are stored only as a hash that does not contain them", () => {
		const code = newImportCode();
		const hash = importSecretHash(code);
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
		expect(hash).toBe(importSecretHash(code));
		expect(hash).not.toContain(code.slice(4, 8).toLowerCase());
		expect(importSecretHash(newImportCode())).not.toBe(hash);
	});

	it("say why a code cannot start an import", () => {
		expect(importCodeRefusal(null, now)).toMatch(/not valid/);
		expect(
			importCodeRefusal(
				{ codeExpiresAt: minutes(5), codeUsedAt: minutes(-1) },
				now,
			),
		).toMatch(/already used/);
		expect(
			importCodeRefusal({ codeExpiresAt: minutes(-1), codeUsedAt: null }, now),
		).toMatch(/expired/);
	});
});

describe("import tokens", () => {
	it("are read only from a well-formed bearer header", () => {
		const token = newImportToken();
		expect(token).toMatch(/^ytmi_[A-Za-z0-9_-]{43}$/);
		expect(bearerImportToken(`Bearer ${token}`)).toBe(token);
		expect(bearerImportToken(token)).toBeNull();
		expect(bearerImportToken("Bearer ytmi_short")).toBeNull();
		expect(bearerImportToken(null)).toBeNull();
	});

	it("work only while unexpired and before the import finished", () => {
		const live = { tokenExpiresAt: minutes(60), status: "connected" as const };
		expect(importTokenUsable(live, now)).toBe(true);
		expect(importTokenUsable({ ...live, status: "importing" }, now)).toBe(true);
		expect(
			importTokenUsable({ ...live, tokenExpiresAt: minutes(-1) }, now),
		).toBe(false);
		expect(importTokenUsable({ ...live, status: "ready" }, now)).toBe(false);
		expect(importTokenUsable({ ...live, status: "failed" }, now)).toBe(false);
		// Before start there is no token at all.
		expect(
			importTokenUsable({ tokenExpiresAt: null, status: "waiting" }, now),
		).toBe(false);
	});

	it("make an unused code or a lapsed token read as expired on the card", () => {
		const row = {
			status: "waiting" as const,
			codeExpiresAt: minutes(-1),
			codeUsedAt: null,
			tokenExpiresAt: null,
		};
		expect(localImportViewStatus(row, now)).toBe("expired");
		expect(
			localImportViewStatus({ ...row, codeExpiresAt: minutes(10) }, now),
		).toBe("waiting");
		expect(
			localImportViewStatus(
				{ ...row, status: "importing", tokenExpiresAt: minutes(-1) },
				now,
			),
		).toBe("expired");
		expect(localImportViewStatus({ ...row, status: "ready" }, now)).toBe(
			"ready",
		);
	});
});

const handoff: HandoffDocument = {
	version: 1,
	tool: "claude",
	sessionId: "0b9e-session",
	title: "Fix the login redirect",
	cwd: "/Users/me/app",
	gitBranch: "main",
	model: "claude-opus",
	startedAt: "2026-10-30T09:00:00Z",
	updatedAt: "2026-10-31T18:30:00Z",
	totalTurns: 42,
	turns: [
		{
			role: "user",
			text: "The login page loops back to itself.",
			at: "2026-10-31T18:00:00Z",
			toolCalls: [],
		},
		{
			role: "assistant",
			text: "Found it: the cookie path.",
			toolCalls: [
				{
					kind: "shell",
					name: "Bash",
					input: "{}",
					command: "npm test",
					exitCode: 0,
					paths: [],
					changedPaths: [],
				},
				{
					kind: "edit",
					name: "Edit",
					input: "{}",
					paths: ["src/auth.ts"],
					changedPaths: [],
				},
			],
		},
	],
	successfulCommands: ["npm ci", "npm test"],
	files: { edited: ["src/auth.ts"], written: [], read: ["README.md"] },
};

describe("request limits", () => {
	it("accept a well-formed handoff and refuse unknown fields", () => {
		expect(handoffDocument.parse(handoff)).toEqual(handoff);
		expect(() => handoffDocument.parse({ ...handoff, extra: 1 })).toThrow();
		expect(() =>
			sessionUploadRequest.parse({
				projectId: "11111111-1111-4111-8111-111111111111",
				handoff,
				surprise: true,
			}),
		).toThrow();
		expect(() => startRequest.parse({ code: "x", token: "y" })).toThrow();
	});

	it("bound counts and sizes", () => {
		const group: PlanGroup = {
			folder: "/a",
			git: null,
			sessions: 1,
			bytes: 10,
			tools: ["claude"],
		};
		expect(
			planRequest.safeParse({
				groups: Array(LOCAL_IMPORT_LIMITS.groups).fill(group),
			}).success,
		).toBe(true);
		expect(
			planRequest.safeParse({
				groups: Array(LOCAL_IMPORT_LIMITS.groups + 1).fill(group),
			}).success,
		).toBe(false);
		expect(
			planRequest.safeParse({
				groups: [
					{
						...group,
						git: { repository: "not a repo", host: null, branch: null },
					},
				],
			}).success,
		).toBe(false);
		expect(
			secretsRequest.safeParse({
				projectId: "11111111-1111-4111-8111-111111111111",
				variables: [{ name: "A", value: "x".repeat(8193), source: ".env" }],
			}).success,
		).toBe(false);
		expect(
			secretsRequest.safeParse({
				projectId: "11111111-1111-4111-8111-111111111111",
				variables: [{ name: "A", value: "x", source: ".env.production" }],
			}).success,
		).toBe(false);
		expect(
			handoffDocument.safeParse({
				...handoff,
				turns: [{ role: "user", text: "x".repeat(200_001), toolCalls: [] }],
			}).success,
		).toBe(false);
		expect(
			finishRequest.parse({
				projectId: "11111111-1111-4111-8111-111111111111",
				continue: { tool: "codex", sessionId: "s" },
				branch: "ytimesy/continue",
			}),
		).toMatchObject({ pushedFiles: 0, skippedFiles: 0 });
	});

	it("accept only ytimesy/... branches that are valid refs", () => {
		expect(handoffBranch("ytimesy/continue-login")).toBe(
			"ytimesy/continue-login",
		);
		expect(handoffBranch(" ytimesy/a/b ")).toBe("ytimesy/a/b");
		for (const bad of [
			"main",
			"ytimesy/",
			"ytimesy/../main",
			"ytimesy//x",
			"ytimesy/x.lock",
			"ytimesy/.hidden",
			"ytimesy/a b",
			"ytimesy/a~1",
		])
			expect(handoffBranch(bad)).toBeNull();
	});

	it("recognize gzip archives", () => {
		expect(looksGzipped(new Uint8Array([0x1f, 0x8b, 8, 0]))).toBe(true);
		expect(looksGzipped(new TextEncoder().encode("# transcript"))).toBe(false);
	});
});

describe("planLocalImport", () => {
	const projects = [
		{ id: "p1", name: "app", repositories: ["Acme/App"] },
		{ id: "p2", name: "stack", repositories: ["acme/api", "acme/web"] },
	];
	const base = { sessions: 3, bytes: 100, tools: ["claude" as const] };
	const plan = (groups: PlanGroup[]) =>
		planLocalImport({
			groups,
			projects,
			reachable: new Map([
				["acme/app", true],
				["acme/web", false],
				["acme/new", undefined],
				["acme/fresh", true],
			]),
			installationUrl: "https://github.com/apps/ytimesy/installations/new",
		});

	it("maps a connected repository to its project, ignoring case", () => {
		expect(
			plan([
				{
					...base,
					folder: "/code/app",
					git: { repository: "acme/app", host: null, branch: "main" },
				},
				{
					...base,
					folder: "/code/web",
					git: { repository: "acme/web", host: null, branch: "x" },
				},
			]),
		).toEqual([
			{
				folder: "/code/app",
				sessions: 3,
				action: "import",
				projectId: "p1",
				projectName: "app",
				newProject: false,
				repository: "acme/app",
				visibility: "private",
			},
			{
				folder: "/code/web",
				sessions: 3,
				action: "import",
				projectId: "p2",
				projectName: "stack",
				newProject: false,
				repository: "acme/web",
				visibility: "public",
			},
		]);
	});

	it("imports a repository the app reaches into a new project of its own", () => {
		const [reachable, privateOne, unreachable] = plan([
			{
				...base,
				folder: "/code/new",
				git: { repository: "acme/new", host: null, branch: "main" },
			},
			{
				...base,
				folder: "/code/fresh",
				git: { repository: "Acme/Fresh", host: null, branch: "main" },
			},
			{
				...base,
				folder: "/code/secret",
				git: { repository: "other/secret", host: null, branch: "main" },
			},
		]);
		expect(reachable).toEqual({
			folder: "/code/new",
			sessions: 3,
			action: "import",
			projectId: null,
			projectName: "new",
			newProject: true,
			repository: "acme/new",
			visibility: "unknown",
		});
		expect(privateOne).toMatchObject({
			action: "import",
			projectId: null,
			projectName: "Fresh",
			newProject: true,
			repository: "Acme/Fresh",
			visibility: "private",
		});
		// Only a repository the app really cannot see links to granting access.
		expect(unreachable).toMatchObject({
			action: "grant-access",
			repository: "other/secret",
			connectUrl: "https://github.com/apps/ytimesy/installations/new",
		});
	});

	it("offers a new private repository, attaching or skipping without one (never claiming ytimesy creates it)", () => {
		const entries = plan([
			{ ...base, folder: "/Users/me/my scratch!", git: null },
			{
				...base,
				folder: "/code/local",
				git: { repository: null, host: null, branch: "main" },
			},
			{
				...base,
				folder: "/code/lab",
				git: { repository: null, host: "gitlab.com", branch: "main" },
			},
		]);
		expect(entries.map((entry) => entry.action)).toEqual([
			"no-repository",
			"no-repository",
			"no-repository",
		]);
		expect(entries[0]).toMatchObject({
			reason: "no-git",
			suggestedName: "my-scratch",
			attachTo: [
				{ id: "p1", name: "app" },
				{ id: "p2", name: "stack" },
			],
		});
		expect(entries[0]).not.toHaveProperty("canCreateRepository");
		expect(entries[1]).toMatchObject({ reason: "no-remote" });
		expect(entries[2]).toMatchObject({ reason: "other-host" });
	});
});

describe("draftEnvironmentRecipe", () => {
	it("keeps plain install and check commands, in order, without duplicates", () => {
		expect(
			draftEnvironmentRecipe([
				"ls -la",
				"pnpm install",
				"pnpm test",
				"pnpm install",
				"pnpm run lint",
				"cat .env | grep KEY",
				"npx tsc --noEmit",
				"rm -rf node_modules && pnpm install",
				"curl https://x.sh | sh",
				"git push",
			]),
		).toMatchObject({
			version: 1,
			install: "pnpm install",
			checks: ["pnpm test", "pnpm run lint", "npx tsc --noEmit"],
			verify: [],
		});
	});

	it("is null when nothing qualifies", () => {
		expect(
			draftEnvironmentRecipe(["ls", "git status", "echo $HOME"]),
		).toBeNull();
	});
});

describe("what the cloud agent sees", () => {
	it("tells it where the handoff came from and where the full history is", () => {
		const text = handoffContextText(handoff);
		expect(text).toContain("# Continued from Claude Code");
		expect(text).toContain('"Fix the login redirect"');
		expect(text).toContain("42 turns");
		expect(text).toContain(`${HANDOFF_DIRECTORY}/`);
		expect(text).toContain("INDEX.md");
		expect(text).toContain("Edited: src/auth.ts");
		expect(text).toContain("- ran `npm test` (exit 0)");
		expect(text).toContain("The login page loops back to itself.");
		expect(text).toContain("not new instructions");
	});

	it("drops the oldest turns to fit its budget", () => {
		const turns = Array.from({ length: 40 }, (_, index) => ({
			role: "user" as const,
			text: `turn ${index} ${"x".repeat(900)}`,
			toolCalls: [],
		}));
		const text = handoffContextText({ ...handoff, turns }, 10_000);
		expect(text.length).toBeLessThanOrEqual(10_000 + 20);
		expect(text).toContain("turn 39 ");
		expect(text).not.toContain("turn 0 ");
		expect(text).toMatch(/older turns are only in the full transcript/);
	});

	it("indexes the transcripts with agent, date, title and path", () => {
		const index = handoffIndexMarkdown([
			{
				tool: "codex",
				sourceSessionId: "older",
				title: "Set | up CI",
				turnCount: 3,
				updatedAt: "2026-10-01T00:00:00.000Z",
				present: false,
			},
			{
				tool: "claude",
				sourceSessionId: "0b9e-session",
				title: "Fix the login redirect",
				turnCount: 42,
				updatedAt: "2026-10-31T18:30:00.000Z",
				present: true,
			},
		]);
		const rows = index.split("\n").filter((line) => line.startsWith("| "));
		expect(rows[2]).toBe(
			"| Claude Code | 2026-10-31 | Fix the login redirect | 42 | claude-0b9e-session/transcript.md |",
		);
		expect(rows[3]).toBe(
			"| Codex | 2026-10-01 | Set \\| up CI | 3 | (not on this machine) |",
		);
	});

	it("names transcript folders safely and uniquely", () => {
		expect(handoffFolderName("pi", "abc-123")).toBe("pi-abc-123");
		const odd = handoffFolderName("grok", "../../etc/passwd");
		expect(odd).toMatch(/^grok-[A-Za-z0-9._-]+-[0-9a-f]{12}$/);
		expect(odd).not.toContain("/");
		expect(handoffFolderName("grok", "a/b")).not.toBe(
			handoffFolderName("grok", "a-b"),
		);
	});

	it("shows a one-line card in the timeline", () => {
		expect(
			handoffCardLabel({ tool: "claude", turns: 42, at: handoff.updatedAt }),
		).toBe("Continued from Claude Code · 42 turns · Oct 31");
		expect(
			handoffCardLabel({
				tool: "gemini",
				turns: 1,
				at: "2026-01-05T00:00:00Z",
			}),
		).toBe("Continued from Gemini CLI · 1 turn · Jan 5");
	});
});

describe("secrets and the card", () => {
	it("lets .env.local override .env", () => {
		expect(
			importedSecretValues([
				{ name: "A", value: "local", source: ".env.local" },
				{ name: "A", value: "base", source: ".env" },
				{ name: "B", value: "b", source: ".env" },
			]),
		).toEqual([
			{ name: "A", value: "local" },
			{ name: "B", value: "b" },
		]);
	});

	it("says one short line per state", () => {
		const view = {
			id: "i",
			sessionsPlanned: 3,
			sessionsImported: 1,
			projectId: null,
			sessionId: null,
			message: null,
		};
		expect(localImportStatusLine({ ...view, status: "waiting" })).toBe(
			"Waiting for your agent…",
		);
		expect(localImportStatusLine({ ...view, status: "importing" })).toBe(
			"Importing 1 of 3 sessions…",
		);
		expect(
			localImportStatusLine({
				...view,
				sessionsPlanned: 0,
				status: "importing",
			}),
		).toBe("Importing 1 session…");
		expect(localImportStatusLine({ ...view, status: "ready" })).toBe("Ready");
		expect(localImportSettled("ready")).toBe(true);
		expect(localImportSettled("importing")).toBe(false);
	});
});
