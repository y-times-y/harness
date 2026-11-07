import { describe, expect, it } from "vitest";
import {
	agentCapturesSummary,
	CAPTURES_START,
	EVIDENCE_END,
	type EvidenceManifest,
	evidenceManifest,
	evidenceMediaPath,
	evidencePagePath,
	evidencePageUrl,
	evidencePlanFor,
	evidenceRequestFromText,
	evidenceSectionState,
	renderAgentCapturesSection,
	renderEvidenceSection,
	visiblePath,
	withAgentCapturesSection,
	withEvidenceSection,
} from "./pr-evidence";
import { withPullRequestFooter } from "./pull-request-footer";

const sha = "c3c0528b5e6e62912fb34a066cf13a9fb81eb770";

function manifest(overrides: Partial<EvidenceManifest> = {}) {
	return evidenceManifest.parse({
		version: 1,
		mode: "verify",
		kind: "web",
		status: "captured",
		sha,
		clean: true,
		startCommand: "pnpm dev",
		startSource: "plan",
		urls: ["http://localhost:5173/", "http://localhost:5173/settings"],
		pages: [
			{
				url: "http://localhost:5173/",
				status: 200,
				title: "Home",
				screenshot: "01-home.png",
			},
			{
				url: "http://localhost:5173/settings",
				status: 500,
				title: "",
				screenshot: null,
				error: "net::ERR",
			},
		],
		flow: [
			{ step: "click text=Save", ok: true, screenshot: null },
			{ step: "screenshot saved", ok: true, screenshot: "02-saved.png" },
		],
		video: { file: "recording.webm", seconds: 9.6 },
		files: [
			{ name: "01-home.png", bytes: 10, sha256: "a".repeat(64) },
			{ name: "02-saved.png", bytes: 10, sha256: "b".repeat(64) },
			{
				name: "recording.webm",
				bytes: 2 * 1024 * 1024,
				sha256: "c".repeat(64),
			},
		],
		browser: "Chrome 155 headless, Playwright 1.63.0",
		viewport: "1280x800",
		startedAt: "2026-10-18T16:45:11Z",
		appReadyAt: "2026-10-18T16:45:13Z",
		finishedAt: "2026-10-18T16:45:17Z",
		...overrides,
	});
}

const projectId = "0f8b6c1e-2d3a-4b5c-8d9e-0a1b2c3d4e5f";
const evidenceId = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const pageUrl = `https://app.ytimesy.test/projects/${projectId}/evidence/${evidenceId}`;

describe("capture plans", () => {
	it("accepts the plan ytimesy-evidence saves and refuses pages outside the workspace", () => {
		const saved = {
			version: 1,
			mode: "web",
			start: "node server.js",
			urls: ["/about", "http://localhost:4317/"],
			flow: [{ action: "click", selector: "text=Save" }],
			startSeconds: 90,
		};
		expect(evidenceRequestFromText(JSON.stringify(saved))).toMatchObject({
			mode: "web",
			urls: ["/about", "http://localhost:4317/"],
		});
		for (const url of [
			"https://example.com/",
			"//evil.example/x",
			"http://user:pw@localhost:3000/",
			"file:///etc/passwd",
		])
			expect(
				evidenceRequestFromText(JSON.stringify({ ...saved, urls: [url] })),
			).toBeNull();
		expect(
			evidenceRequestFromText(
				JSON.stringify({ ...saved, start: "pnpm dev\nrm -rf /" }),
			),
		).toBeNull();
		expect(
			evidenceRequestFromText(
				JSON.stringify({
					...saved,
					flow: Array.from({ length: 21 }, () => ({ action: "wait", ms: 1 })),
				}),
			),
		).toBeNull();
		expect(
			evidenceRequestFromText(
				JSON.stringify({ ...saved, flow: [{ action: "wait", ms: 60_000 }] }),
			),
		).toBeNull();
		expect(evidenceRequestFromText("not json")).toBeNull();
		expect(evidenceRequestFromText("")).toBeNull();
	});

	it("captures only visible diffs unless the builder saved a plan", () => {
		expect(visiblePath("src/components/Button.tsx")).toBe(true);
		expect(visiblePath("app/globals.css")).toBe(true);
		expect(visiblePath("src/routes/settings.ts")).toBe(true);
		expect(visiblePath("src/server/db.ts")).toBe(false);
		expect(visiblePath("src/components/Button.test.tsx")).toBe(false);
		expect(visiblePath("docs/guide.mdx")).toBe(false);
		expect(visiblePath("README.md")).toBe(false);
		expect(
			evidencePlanFor({ request: null, changedPaths: ["src/server/db.ts"] }),
		).toBeNull();
		expect(
			evidencePlanFor({ request: null, changedPaths: ["src/App.tsx"] }),
		).toEqual({ version: 1, mode: "auto" });
		const cli = {
			version: 1,
			mode: "cli",
			command: "node cli --help",
		} as const;
		expect(evidencePlanFor({ request: cli, changedPaths: [] })).toBe(cli);
	});
});

describe("evidence page links", () => {
	it("builds page and media paths only from ids and allowed file names", () => {
		expect(evidencePagePath(projectId, evidenceId)).toBe(
			`/projects/${projectId}/evidence/${evidenceId}`,
		);
		expect(evidenceMediaPath(projectId, evidenceId, "01-home.png")).toBe(
			`/api/projects/${projectId}/evidence/${evidenceId}/01-home.png`,
		);
		for (const name of ["../x.png", "a.html", "x/y.png", ".png"])
			expect(() => evidenceMediaPath(projectId, evidenceId, name)).toThrow();
		expect(() => evidencePagePath("../admin", evidenceId)).toThrow();
	});

	it("links the page only on an HTTPS (or local) app origin", () => {
		expect(
			evidencePageUrl("https://app.ytimesy.test/", projectId, evidenceId),
		).toBe(pageUrl);
		expect(
			evidencePageUrl("http://localhost:3000", projectId, evidenceId),
		).toBe(
			`http://localhost:3000/projects/${projectId}/evidence/${evidenceId}`,
		);
		for (const origin of [
			undefined,
			"",
			"http://app.ytimesy.test",
			"https://user:pw@app.ytimesy.test",
			"not a url",
		])
			expect(evidencePageUrl(origin, projectId, evidenceId)).toBeNull();
	});
});

describe("Evidence section", () => {
	it("is a short summary with a link to the evidence page, no media", () => {
		const section = renderEvidenceSection({
			manifest: manifest(),
			planKey: "web-abc",
			headSha: sha,
			pageUrl,
		});
		expect(section).toBe(
			[
				`<!-- ytimesy-evidence:start sha=${sha} plan=web-abc -->`,
				"## Evidence",
				"",
				"Verified by the ytimesy harness from a clean checkout of `c3c0528`, the pull request head: 2 screenshots, 10 s screen recording.",
				"",
				`[View the evidence](${pageUrl}) in ytimesy (sign-in required). It is kept for 30 days or until this pull request closes.`,
				EVIDENCE_END,
			].join("\n"),
		);
		expect(section).not.toContain("![");
		expect(section).not.toContain("github.com");
	});

	it("does not call evidence from another commit the pull request head, and counts failed steps", () => {
		const section = renderEvidenceSection({
			manifest: manifest({
				flow: [
					{ step: "click x", ok: false, error: "timeout", screenshot: null },
				],
			}),
			planKey: "web-abc",
			headSha: "f".repeat(40),
			pageUrl,
		});
		expect(section).toContain(
			"Verified by the ytimesy harness from commit `c3c0528`: 2 screenshots, 10 s screen recording (1 flow step failed).",
		);
	});

	it("says the app did not start and still links the details", () => {
		const section = renderEvidenceSection({
			manifest: manifest({
				status: "app-failed",
				reason:
					"The start command exited with status 1 before the app answered.",
				pages: [],
				flow: [],
				video: null,
				files: [],
			}),
			planKey: "auto-1",
			headSha: sha,
			pageUrl,
		});
		expect(section).toContain(
			"The app did not start at commit `c3c0528`, so there are no screenshots or recording for it: The start command exited with status 1 before the app answered.",
		);
		expect(section).toContain(`[View the evidence](${pageUrl})`);
	});

	it("summarizes CLI output without pasting it", () => {
		const section = renderEvidenceSection({
			manifest: manifest({
				kind: "cli",
				pages: [],
				flow: [],
				video: null,
				startSource: "cli",
				startCommand: "node cli --help",
				cli: { command: "node cli --help", exitCode: 0, file: "output.txt" },
				files: [{ name: "output.txt", bytes: 12, sha256: "d".repeat(64) }],
			}),
			planKey: "cli-1",
			headSha: sha,
			pageUrl: null,
		});
		expect(section).toContain(": CLI output.");
		expect(section).toContain("The evidence page is unavailable.");
		expect(section).not.toContain("```");
	});

	it("replaces its own section on a new push and keeps the rest of the description", () => {
		const first = renderEvidenceSection({
			manifest: manifest(),
			planKey: "web-1",
			headSha: sha,
			pageUrl,
		});
		const body = withEvidenceSection("Fixes the button.\n", first);
		expect(
			body.startsWith("Fixes the button.\n\n<!-- ytimesy-evidence:start"),
		).toBe(true);
		expect(evidenceSectionState(body)).toEqual({ sha, plan: "web-1" });
		const next = renderEvidenceSection({
			manifest: manifest({ sha: "d".repeat(40) }),
			planKey: "web-2",
			headSha: "d".repeat(40),
			pageUrl,
		});
		const updated = withEvidenceSection(`${body}\n\nReviewer notes`, next);
		expect(updated.match(/ytimesy-evidence:start/g)).toHaveLength(1);
		expect(updated).toContain("Reviewer notes");
		expect(updated).toContain("Fixes the button.");
		expect(evidenceSectionState(updated)).toEqual({
			sha: "d".repeat(40),
			plan: "web-2",
		});
		expect(withEvidenceSection(null, next)).toBe(next);
	});

	it("escapes the failure reason", () => {
		const section = renderEvidenceSection({
			manifest: manifest({
				status: "tooling-failed",
				reason: "](javascript:alert(1)) <img>",
			}),
			planKey: "web-1",
			headSha: sha,
			pageUrl,
		});
		expect(section).toContain("\\]\\(javascript:alert\\(1\\)\\) \\<img\\>");
	});
});

describe("agent captures in the Evidence section", () => {
	const capturesUrl =
		"https://app.example/projects/p/evidence/33333333-3333-4333-8333-333333333333";
	const captures = renderAgentCapturesSection({
		summary: "1 screenshot, 1 recording (5 s)",
		pageUrl: capturesUrl,
	}) as string;

	it("counts screenshots and recordings with their lengths", () => {
		expect(
			agentCapturesSummary([
				{ files: [{ name: "screenshot-a.png" }], videoSeconds: null },
				{ files: [{ name: "recording-a.mp4" }], videoSeconds: 4.6 },
				{ files: [{ name: "recording-b.webm" }], videoSeconds: 12 },
			]),
		).toBe("1 screenshot, 2 recordings (5 s, 12 s)");
		expect(agentCapturesSummary([])).toBe("");
		expect(
			renderAgentCapturesSection({ summary: "", pageUrl: null }),
		).toBeNull();
	});

	it("is an Evidence section with a count and the evidence page link, no media", () => {
		const body = withAgentCapturesSection(
			withPullRequestFooter("## Summary\n\nAdds a README line.", {}),
			captures,
		);
		expect(body).toContain(
			"## Evidence\n\nCaptured by the agent on its desktop: 1 screenshot, 1 recording (5 s).",
		);
		expect(body).toContain(
			`[View the evidence](${capturesUrl}) in ytimesy (sign-in required).`,
		);
		expect(body).not.toContain("![");
		// Before the footer, and replaced rather than repeated.
		expect(body.indexOf(CAPTURES_START)).toBeLessThan(
			body.indexOf("Generated with ytimesy"),
		);
		const again = withAgentCapturesSection(body, captures);
		expect(again).toBe(body);
		expect(withAgentCapturesSection(body, null)).not.toContain(CAPTURES_START);
	});

	it("joins a harness Evidence section under one heading", () => {
		const harness = renderEvidenceSection({
			manifest: manifest(),
			planKey: "web-abc",
			headSha: sha,
			pageUrl,
		});
		const withCaptures = withAgentCapturesSection("Intro", captures);
		const body = withEvidenceSection(withCaptures, harness);
		expect(body.match(/## Evidence/g)).toHaveLength(1);
		expect(body.indexOf(EVIDENCE_END)).toBeLessThan(
			body.indexOf("Captured by the agent"),
		);
		expect(body).toContain(`[View the evidence](${capturesUrl})`);
		expect(withAgentCapturesSection(body, captures)).toBe(body);
	});
});
