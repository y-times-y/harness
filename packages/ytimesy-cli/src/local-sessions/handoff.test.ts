import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverClaudeSessions } from "./claude.ts";
import { exportFullTranscript } from "./full-transcript.ts";
import {
	digestDroppedTurns,
	redact,
	successfulCommands,
	touchedFiles,
	trimToBudget,
} from "./handoff-helpers.ts";
import {
	claude21Records,
	claudeFile,
	createFixtureWorld,
	type FixtureWorld,
	required,
	writeJsonl,
} from "./test-fixtures.ts";
import { createToolCall } from "./tool-calls.ts";
import type { LocalSession, ToolCall, Turn } from "./types.ts";

function shell(command: string, exitCode?: number): ToolCall {
	const call = createToolCall({ name: "Bash", input: { command } });
	if (exitCode !== undefined) call.exitCode = exitCode;
	return call;
}

function turn(
	role: Turn["role"],
	text: string,
	toolCalls: ToolCall[] = [],
): Turn {
	return { role, text, toolCalls };
}

function session(turns: Turn[], cwd = "/repo"): LocalSession {
	return {
		tool: "claude",
		id: "s",
		cwd,
		updatedAt: 0,
		turns,
		readFromStart: true,
		unparsedRecords: 0,
	};
}

describe("successfulCommands", () => {
	it("keeps exit-0 shell commands once, in first-run order", () => {
		const result = successfulCommands(
			session([
				turn("assistant", "", [
					shell("pnpm install", 0),
					shell("pnpm test", 1),
					shell("pnpm build"),
					shell("pnpm install", 0),
				]),
				turn("assistant", "", [shell("pnpm lint", 0)]),
			]),
		);
		expect(result).toEqual(["pnpm install", "pnpm lint"]);
	});
});

describe("touchedFiles", () => {
	it("separates edited, written and read files, relative to the root", () => {
		const calls = [
			createToolCall({ name: "Read", input: { file_path: "/repo/a.ts" } }),
			createToolCall({ name: "Read", input: { file_path: "/repo/b.ts" } }),
			createToolCall({ name: "Edit", input: { file_path: "/repo/a.ts" } }),
			createToolCall({ name: "Write", input: { file_path: "c.ts" } }),
			createToolCall({
				name: "apply_patch",
				input: "*** Begin Patch\n*** Update File: d.ts\n*** End Patch",
			}),
		];
		expect(
			touchedFiles(session([turn("assistant", "", calls)], "/repo"), {
				root: "/repo",
			}),
		).toEqual({
			edited: ["a.ts", "d.ts"],
			written: ["c.ts"],
			read: ["b.ts"],
		});
	});
});

describe("redact", () => {
	it("replaces secret values in every string field without mutating the input", () => {
		const original = session([
			turn("user", "token sk-123 and sk-1234"),
			turn("assistant", "", [
				{ ...shell("curl -H 'auth: sk-1234'", 0), output: "sk-1234 ok" },
			]),
		]);
		const clean = redact(original, ["sk-1234", "sk-123", ""]);
		expect(clean.turns[0]?.text).toBe("token [REDACTED] and [REDACTED]");
		expect(clean.turns[1]?.toolCalls[0]).toMatchObject({
			command: "curl -H 'auth: [REDACTED]'",
			output: "[REDACTED] ok",
		});
		expect(original.turns[0]?.text).toContain("sk-123");
	});
});

describe("trimToBudget", () => {
	it("keeps the newest turns and prepends a digest of what was dropped", () => {
		const turns = [
			turn("user", "please fix the login bug", [
				createToolCall({
					name: "Edit",
					input: { file_path: "src/auth.rs", old_string: "x", new_string: "y" },
				}),
			]),
			turn("assistant", "a".repeat(100)),
			turn("user", "c".repeat(100)),
		];
		const result = trimToBudget(turns, 150);
		expect(result).toHaveLength(2);
		expect(result[0]).toMatchObject({ synthetic: "trim-digest" });
		expect(result[0]?.text).toContain("login bug");
		expect(result[0]?.text).toContain("Edit");
		expect(result[0]?.text).toContain("src/auth.rs");
		expect(result[1]?.text.startsWith("c")).toBe(true);
	});

	it("is a no-op under budget", () => {
		const turns = [turn("user", "a"), turn("assistant", "b")];
		expect(trimToBudget(turns, 1000)).toEqual(turns);
	});

	it("keeps the newest compaction summary and drops what it summarized", () => {
		const turns: Turn[] = [
			turn("user", "old task"),
			turn("assistant", "old reply"),
			{
				role: "user",
				text: "Summary: built it.",
				toolCalls: [],
				synthetic: "compaction-summary",
			},
			turn("user", "keep going"),
		];
		const result = trimToBudget(turns, 10_000);
		expect(result.map((item) => item.text)).toEqual([
			"Summary: built it.",
			"keep going",
		]);
	});

	it("always keeps the newest turn, cut to the budget", () => {
		const result = trimToBudget(
			[turn("user", "x".repeat(50)), turn("assistant", "y".repeat(500))],
			100,
		);
		expect(result.at(-1)?.text.startsWith("y".repeat(100))).toBe(true);
		expect(result.at(-1)?.text.length).toBeLessThanOrEqual(101);
	});

	it("digest is undefined when nothing was dropped", () => {
		expect(digestDroppedTurns([])).toBeUndefined();
	});
});

describe("exportFullTranscript", () => {
	let world: FixtureWorld;
	beforeEach(() => {
		world = createFixtureWorld();
	});
	afterEach(() => world.cleanup());

	function writeFixture(): void {
		const records: object[] = claude21Records(world.repo);
		const longOutput = `${"line of output\n".repeat(400)}secret-value-123 at the end`;
		records.push(
			{
				type: "assistant",
				cwd: world.repo,
				message: {
					id: "msg_9",
					role: "assistant",
					model: "m",
					content: [
						{
							type: "tool_use",
							id: "toolu_9",
							name: "Bash",
							input: { command: "cat big.log" },
						},
					],
				},
			},
			{
				type: "user",
				cwd: world.repo,
				message: {
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "toolu_9",
							is_error: false,
							content: [
								{ type: "text", text: longOutput },
								{
									type: "image",
									source: {
										type: "base64",
										media_type: "image/png",
										data: "aGVsbG8=",
									},
								},
							],
						},
					],
				},
				toolUseResult: { stdout: longOutput, stderr: "", interrupted: false },
			},
		);
		writeJsonl(claudeFile(world.home, world.repo, "c21"), records);
	}

	it("writes every message and complete tool output, drops bookkeeping, writes images and redacts", () => {
		writeFixture();
		const [ref] = discoverClaudeSessions(world.repo, world.home);
		const outputFile = path.join(world.home, "out", "transcript.md");
		const result = exportFullTranscript(required(ref), {
			outputFile,
			redactValues: ["secret-value-123"],
		});
		const markdown = fs.readFileSync(outputFile, "utf8");
		expect(markdown).toContain("## 1 user · 2026-01-01T00:00:01.000Z");
		expect(markdown).toContain("fix the parser please");
		expect(markdown).toContain("### tool: Bash (toolu_1)");
		expect(markdown).toContain("#### result (toolu_2) [exit 1, error]");
		expect(markdown.split("line of output").length - 1).toBe(400);
		expect(markdown).toContain("[REDACTED] at the end");
		expect(markdown).not.toContain("secret-value-123");
		expect(markdown).not.toContain("hook_success");
		expect(markdown).not.toContain("private reasoning");
		expect(result.images).toEqual([
			path.join("transcript-images", "image-0001.png"),
		]);
		expect(
			fs.readFileSync(
				path.join(world.home, "out", required(result.images[0])),
				"utf8",
			),
		).toBe("hello");
		expect(result.toolCalls).toBe(6);
	});

	it("includes readable thinking only when asked", () => {
		writeFixture();
		const [ref] = discoverClaudeSessions(world.repo, world.home);
		const outputFile = path.join(world.home, "out", "with-thinking.md");
		exportFullTranscript(required(ref), { outputFile, includeThinking: true });
		expect(fs.readFileSync(outputFile, "utf8")).toContain(
			"### thinking\n\n```\nprivate reasoning\n```",
		);
	});
});
