import { describe, expect, it } from "vitest";
import {
	handoffSummary,
	isAcknowledgement,
	plainSummaryText,
	repositoryRelativePath,
	SUMMARY_FILES,
	shortened,
} from "./handoff-summary";
import type { HandoffDocument } from "./local-import";

type Turn = HandoffDocument["turns"][number];
const user = (text: string, extra: Partial<Turn> = {}): Turn => ({
	role: "user",
	text,
	toolCalls: [],
	...extra,
});
const agent = (text: string): Turn => ({
	role: "assistant",
	text,
	toolCalls: [],
});

function handoff(overrides: Partial<HandoffDocument> = {}): HandoffDocument {
	return {
		version: 1,
		tool: "claude",
		sessionId: "s1",
		title: "Fix the login redirect",
		cwd: "/Users/alice/app",
		gitBranch: "fix-login",
		updatedAt: "2026-11-01T10:00:00Z",
		totalTurns: 221,
		turns: [],
		successfulCommands: [],
		files: { edited: [], written: [], read: [] },
		...overrides,
	};
}

const transcript = "~/.ytimesy/handoff/claude-s1/transcript.md";

describe("handoff summary", () => {
	it("takes the first request, the gist of the last reply and its next step", () => {
		const summary = handoffSummary(
			handoff({
				turns: [
					user(
						"<command-name>/clear</command-name>\nThe login page loops after OAuth. Please fix it and add a test.",
					),
					agent("Looking at the redirect handler."),
					user("Also keep the session cookie."),
					agent(
						"Done — the redirect now checks the session first. Tests pass.\n\n## Next steps\n- Ship the cookie change behind a flag\n- Update the docs",
					),
				],
			}),
			{ transcript },
		);
		expect(summary.goal).toBe("The login page loops after OAuth.");
		expect(summary.stopped).toBe(
			"Done — the redirect now checks the session first.",
		);
		expect(summary.next).toBe("Ship the cookie change behind a flag");
		expect(summary.localBranch).toBe("fix-login");
		expect(summary.transcript).toBe(transcript);
	});

	it("uses an unanswered last request as next, and the title once early turns were trimmed", () => {
		const summary = handoffSummary(
			handoff({
				turns: [
					user("Earlier turns, digested.", { synthetic: "trim-digest" }),
					user("Rename the helper."),
					agent("Renamed it in src/a.ts."),
					user("[Request interrupted by user]"),
					user("Now run the e2e suite"),
				],
			}),
			{ transcript },
		);
		expect(summary.goal).toBe("Fix the login redirect");
		expect(summary.stopped).toBe("Renamed it in src/a.ts.");
		expect(summary.next).toBe("Now run the e2e suite");
	});

	it("has no next when nothing is derivable, and nulls for an empty session", () => {
		const plain = handoffSummary(
			handoff({ turns: [user("Fix it"), agent("Fixed.")] }),
			{ transcript },
		);
		expect(plain.next).toBeNull();
		const empty = handoffSummary(handoff({ title: undefined }), {
			transcript,
		});
		expect(empty).toMatchObject({ goal: null, stopped: null, next: null });
	});

	it("keeps lines short and lists files relative to the folder, bounded", () => {
		const long = `${"word ".repeat(80)}end.`;
		const files = Array.from({ length: 30 }, (_, index) => `src/f${index}.ts`);
		const summary = handoffSummary(
			handoff({
				turns: [user(long), agent(long)],
				successfulCommands: ["pnpm test", "pnpm test", "pnpm  lint"],
				files: {
					edited: ["/Users/alice/app/src/a.ts", ...files],
					written: ["src/a.ts", "README.md"],
					read: ["ignored.ts"],
				},
			}),
			{ transcript },
		);
		expect(summary.goal?.length).toBeLessThanOrEqual(110);
		expect(summary.goal?.endsWith("…")).toBe(true);
		expect(summary.stopped?.length).toBeLessThanOrEqual(130);
		expect(summary.edited).toHaveLength(SUMMARY_FILES);
		expect(summary.edited[0]).toBe("src/a.ts");
		expect(summary.editedCount).toBe(32);
		expect(summary.commands).toEqual(["pnpm test", "pnpm lint"]);
	});

	it("drops markup, code and links from the text", () => {
		expect(
			plainSummaryText(
				"**Fixed** the [parser](https://x.test) in `a.ts`:\n```ts\ncode()\n```\n<system-reminder>hidden</system-reminder> done",
			),
		).toBe("Fixed the parser in a.ts: done");
		expect(shortened("one two three four", 10)).toBe("one two…");
	});

	it("skips greetings and approvals for the goal, falling back to the title", () => {
		const summary = handoffSummary(
			handoff({
				turns: [
					user("hi"),
					agent("Hello! What should I work on?"),
					user("check then please i approve"),
					user("Yes, go ahead."),
					user("The checkout total ignores the coupon. Fix it."),
					agent("Fixed the coupon math."),
					user("ok"),
				],
			}),
			{ transcript },
		);
		expect(summary.goal).toBe("The checkout total ignores the coupon.");
		// A trailing "ok" is not an unanswered request.
		expect(summary.next).toBeNull();
		const onlyAcks = handoffSummary(
			handoff({ turns: [user("yes"), agent("Done."), user("thanks!")] }),
			{ transcript },
		);
		expect(onlyAcks.goal).toBe("Fix the login redirect");
	});

	it("tells acknowledgements from requests", () => {
		for (const text of [
			"yes",
			"OK",
			"ok go ahead",
			"Thanks!",
			"lgtm",
			"continue",
			"Sounds good, do it",
			"check then please i approve",
			"hey",
			"",
		])
			expect(isAcknowledgement(text), text).toBe(true);
		for (const text of [
			"yes, fix the tests",
			"continue with the migration",
			"Add a dark mode toggle",
			"hi, the build fails on CI",
			"ok but rename the helper first",
		])
			expect(isAcknowledgement(text), text).toBe(false);
	});

	it("lists paths relative to the repository, including worktrees", () => {
		const cwd = "/Users/alice/.codex/worktrees/a1b2/app";
		expect(repositoryRelativePath(cwd, `${cwd}/src/a.ts`)).toBe("src/a.ts");
		expect(
			repositoryRelativePath(
				"/Users/alice/app",
				"/Users/alice/.codex/worktrees/c3d4/app/src/b.ts",
			),
		).toBe("src/b.ts");
		expect(
			repositoryRelativePath(
				"/Users/alice/app",
				"/Users/alice/app/.claude/worktrees/feature/src/c.ts",
			),
		).toBe("src/c.ts");
		expect(repositoryRelativePath("/Users/alice/app/", "./src/d.ts")).toBe(
			"src/d.ts",
		);
		expect(repositoryRelativePath("/Users/alice/app", "src/e.ts")).toBe(
			"src/e.ts",
		);
		expect(
			repositoryRelativePath("/Users/alice/app", "/Users/alice/notes/todo.md"),
		).toBe("~/notes/todo.md");
		expect(repositoryRelativePath("/home/bob/app", "/etc/hosts")).toBe(
			"/etc/hosts",
		);
		const summary = handoffSummary(
			handoff({
				cwd,
				files: {
					edited: [`${cwd}/src/a.ts`, "src/a.ts"],
					written: [`${cwd}/README.md`],
					read: [],
				},
			}),
			{ transcript },
		);
		expect(summary.edited).toEqual(["src/a.ts", "README.md"]);
	});
});
