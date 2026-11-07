import { describe, expect, it } from "vitest";
import { SessionItemId } from "./ids";
import type { SessionItem } from "./session-item";
import {
	roundCommands,
	roundEvidence,
	sidekickRoundBrief,
	sidekickRoundItems,
	sidekickSignals,
	sidekickStuckReasons,
	warrantsEscalation,
} from "./sidekick-signals";

const bash = (id: string, command: string, output: string): SessionItem => ({
	kind: "dynamicToolCall",
	id: SessionItemId(id),
	tool: "bash",
	input: JSON.stringify({ command }),
	output,
	status: "completed",
});

describe("round evidence", () => {
	it("collects failed checks from every command shape, ignoring no-match probes", () => {
		const items: SessionItem[] = [
			bash(
				"a",
				"npm   test",
				"FAIL src/cli.test.ts\nError: expected 2 to be 3\n\nexit 1",
			),
			bash("b", "grep -n foo src", "\n\nexit 1"),
			bash("c", "ls", "a b\n\nexit 0"),
			{
				kind: "commandExecution",
				id: SessionItemId("d"),
				command: "cargo build",
				cwd: null,
				status: "completed",
				output: "error[E0308]: mismatched types",
				exitCode: 101,
			},
			bash(
				"e",
				"ytimesy-job wait j1",
				'exited: {"reference": "j1", "exitCode": 2, "stdout": "make: *** [Makefile:9: repro] Error 1\\n", "stderr": ""}',
			),
			{
				kind: "dynamicToolCall",
				id: SessionItemId("f"),
				tool: "run_code",
				input: "{}",
				output: JSON.stringify({
					ok: true,
					calls: [
						{
							tool: "exec_command",
							input: JSON.stringify({ cmd: "pytest -q" }),
							output: JSON.stringify({
								output: "1 failed in 0.3s",
								exitCode: 1,
							}),
						},
					],
				}),
				status: "completed",
			},
		];
		const evidence = roundEvidence(items);
		expect(evidence.failedChecks).toEqual([
			"npm test",
			"cargo build",
			"ytimesy-job wait j1",
			"pytest -q",
		]);
		// Numbers are masked so the same error compares equal across runs.
		expect(evidence.errors).toContain("Error: expected # to be #");
		expect(evidence.errors).toContain("make: *** [Makefile:#: repro] Error #");
	});

	it("takes only the current round's part of the history", () => {
		const items: SessionItem[] = [
			{ kind: "userMessage", id: SessionItemId("u1"), text: "brief" },
			bash("a", "make test", "\n\nexit 2"),
			{
				kind: "userMessage",
				id: SessionItemId("u2"),
				text: "Peer message from lead (x):\n\nRound 2/6 from your lead. Next.",
			},
			bash("b", "make lint", "\n\nexit 2"),
		];
		expect(sidekickRoundItems(items, 1)).toHaveLength(4);
		expect(sidekickRoundItems(items, 2).map((item) => item.id)).toEqual(["b"]);
		expect(
			sidekickRoundItems(
				[
					{
						kind: "userMessage",
						id: SessionItemId("u3"),
						text: "Peer message from lead (x):\n\nRound 7 from your lead (1/6 for the user's new request).",
					},
					bash("c", "make", "\n\nexit 0"),
				],
				7,
			),
		).toHaveLength(1);
	});
});

describe("sidekick signals", () => {
	const quiet = { failedChecks: [], errors: [] };
	const base = {
		kind: "build" as const,
		outcome: "finished" as const,
		patchFiles: 2,
		roundsLeft: 3,
	};

	it("fires on the same failed check, the same error, no file change and the round budget", () => {
		expect(
			sidekickSignals({
				...base,
				evidence: { failedChecks: ["make test"], errors: ["E #"] },
				previous: { failedChecks: ["make test"], errors: ["E #"] },
			}),
		).toEqual([{ kind: "same-check-failed", detail: "make test" }]);
		expect(
			sidekickSignals({
				...base,
				evidence: { failedChecks: ["make check"], errors: ["E #"] },
				previous: { failedChecks: ["make test"], errors: ["E #"] },
			}),
		).toEqual([{ kind: "same-error", detail: "E #" }]);
		expect(
			sidekickSignals({ ...base, patchFiles: 0, evidence: quiet }).map(
				(signal) => signal.kind,
			),
		).toEqual(["no-file-change"]);
		expect(
			sidekickSignals({
				...base,
				outcome: "budget exhausted",
				evidence: quiet,
			}).map((signal) => signal.kind),
		).toEqual(["round-budget"]);
		expect(
			sidekickSignals({ ...base, roundsLeft: 0, evidence: quiet })[0]?.detail,
		).toBe("no rounds are left this turn");
	});

	it("stays quiet on a clean round and on an exploration round without changes", () => {
		expect(sidekickSignals({ ...base, evidence: quiet })).toEqual([]);
		expect(
			sidekickSignals({
				...base,
				kind: "explore",
				patchFiles: 0,
				evidence: { failedChecks: ["make test"], errors: [] },
			}),
		).toEqual([]);
	});

	it("words the reasons and calls only stuck signals a reason to switch models", () => {
		const signals = [
			{ kind: "same-check-failed" as const, detail: "make test" },
		];
		expect(sidekickStuckReasons(signals)).toBe(
			"it failed the same check as last round (`make test`)",
		);
		expect(warrantsEscalation(signals)).toBe(true);
		expect(warrantsEscalation([{ kind: "round-budget", detail: "x" }])).toBe(
			false,
		);
	});

	it("lists every command of a round with its exit code and finds the round's brief", () => {
		const items: SessionItem[] = [
			{ kind: "userMessage", id: SessionItemId("b1"), text: "First brief." },
			{
				kind: "dynamicToolCall",
				id: SessionItemId("c1"),
				tool: "bash",
				input: JSON.stringify({ command: "make  test" }),
				output: "ok\n\nexit 0",
				status: "completed",
			},
			{
				kind: "userMessage",
				id: SessionItemId("b2"),
				text: "Peer message from lead (root):\n\nRound 2/6 from your lead. Fix it.",
			},
			{
				kind: "dynamicToolCall",
				id: SessionItemId("c2"),
				tool: "bash",
				input: JSON.stringify({ command: "make lint" }),
				output: "bad\n\nexit 2",
				status: "completed",
			},
		];
		expect(roundCommands(items)).toEqual([
			{ command: "make test", exitCode: 0 },
			{ command: "make lint", exitCode: 2 },
		]);
		expect(sidekickRoundBrief(items, 1)).toBe("First brief.");
		expect(sidekickRoundBrief(items, 2)).toContain("Round 2/6 from your lead");
	});
});
