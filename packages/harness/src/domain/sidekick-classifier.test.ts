import { describe, expect, it } from "vitest";
import {
	applicableDecision,
	CLASSIFIER_MARKER,
	type ClassifierInput,
	classifierMessage,
	parseClassifierReply,
	rulesDecision,
	sidekickDecisionNotice,
	sidekickEscalation,
} from "./sidekick-classifier";

const summary: ClassifierInput = {
	point: "round",
	round: 2,
	roundKind: "build",
	model: "gpt-6-luna",
	brief: "b".repeat(5_000),
	report: "Still failing.",
	commands: Array.from({ length: 20 }, (_, index) => ({
		command: `make step-${index}`,
		exitCode: index === 19 ? 2 : 0,
	})),
	diff: { files: ["src/a.ts"], added: 3, removed: 1 },
	outcome: "finished",
	signals: [{ kind: "same-check-failed", detail: "make test" }],
	canSwitch: true,
};

describe("sidekick classifier", () => {
	it("sends a bounded summary after its marker", () => {
		const message = classifierMessage(summary);
		expect(message.startsWith(`${CLASSIFIER_MARKER}\n`)).toBe(true);
		const body = JSON.parse(message.slice(CLASSIFIER_MARKER.length + 1));
		expect(body.brief.length).toBeLessThanOrEqual(1_501);
		expect(body.commands).toHaveLength(12);
		expect(body.commands.at(-1)).toEqual({ command: "make step-19", exit: 2 });
		expect(body.signals).toEqual(["same-check-failed: make test"]);
		expect(body).toMatchObject({
			round: 2,
			canSwitch: true,
			diff: { files: ["src/a.ts"], added: 3, removed: 1 },
		});
	});

	it("accepts only the exact JSON it asked for", () => {
		expect(
			parseClassifierReply(
				' {"decision": "switch_model", "reason": "repeats make test"} ',
			),
		).toEqual({ decision: "switch_model", reason: "repeats make test" });
		for (const reply of [
			"switch_model",
			'```json\n{"decision":"on_track","reason":"ok"}\n```',
			'{"decision":"escalate","reason":"x"}',
			'{"decision":"on_track"}',
			'{"decision":"on_track","reason":"  "}',
			"[]",
			"",
		])
			expect(parseClassifierReply(reply)).toBeNull();
	});

	it("falls back to the rules: stuck signals switch when it can, else hand back", () => {
		expect(rulesDecision([], true)).toEqual({
			decision: "on_track",
			reason: "no hand-back signal fired",
		});
		expect(rulesDecision(summary.signals, true)).toEqual({
			decision: "switch_model",
			reason: "it failed the same check as last round (`make test`)",
		});
		expect(rulesDecision(summary.signals, false).decision).toBe("hand_back");
		expect(
			rulesDecision([{ kind: "round-budget", detail: "x" }], true).decision,
		).toBe("hand_back");
		expect(
			applicableDecision({ decision: "switch_model", reason: "r" }, false),
		).toEqual({ decision: "hand_back", reason: "r" });
	});

	it("words a notice per decision", () => {
		expect(
			sidekickDecisionNotice({
				label: "1",
				decision: "on_track",
				reason: "fine",
			}),
		).toBe("");
		expect(
			sidekickDecisionNotice({
				label: "1",
				decision: "hand_back",
				reason: "the brief is ambiguous.",
			}),
		).toBe(
			"Runtime notice: writer 1 needs you (the brief is ambiguous). Re-brief it more prescriptively (the exact change, file and line, and the command that must pass), or take over and do it yourself.",
		);
		const switching = sidekickDecisionNotice({
			label: "1",
			decision: "switch_model",
			reason: "it repeats make test",
			switchTo: "codex:gpt-6.1-sol",
		});
		expect(switching).toContain(
			"writer 1 looks stuck (it repeats make test). The runtime switches it to codex:gpt-6.1-sol at its next context compaction",
		);
		expect(switching).toContain("the same writer (session, label 1)");
	});

	it("offers an escalation only to another model", () => {
		const roleModels = { writerEscalation: { model: "codex:gpt-6.1-sol" } };
		expect(sidekickEscalation(roleModels, "gpt-6-luna")).toBe(
			"codex:gpt-6.1-sol",
		);
		expect(sidekickEscalation(roleModels, "gpt-6.1-sol")).toBeUndefined();
		expect(sidekickEscalation({}, "gpt-6-luna")).toBeUndefined();
	});
});
