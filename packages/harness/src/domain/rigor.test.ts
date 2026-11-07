import { describe, expect, it } from "vitest";
import { SessionItemId } from "./ids";
import {
	admittedUnfinished,
	admittedUnverified,
	builderRequirements,
	MAX_BUILDER_REQUIREMENTS,
	RIGOR_BUILDER_INSTRUCTIONS,
	RIGOR_REQUIREMENTS_INSTRUCTIONS,
	requirementsFromText,
	requirementsSegments,
	UNATTENDED_RUN_INSTRUCTIONS,
} from "./rigor";
import type { SessionItem } from "./session-item";

describe("rigor", () => {
	it("finds the lines of a final answer that admit unverified or failing work", () => {
		expect(
			admittedUnverified(
				[
					"Implemented the parser; `make test` exits 0.",
					"Unverified: the Windows path was not tested.",
					"I couldn't verify the upload against the live service.",
					"The flaky integration test still fails.",
				].join("\n"),
			),
		).toEqual([
			"Unverified: the Windows path was not tested.",
			"I couldn't verify the upload against the live service.",
			"The flaky integration test still fails.",
		]);
	});

	it("finds, for unattended runs, questions to the user and missing deliverables", () => {
		expect(
			admittedUnfinished(
				[
					"Checked the VCF; the reference build in the config contradicts the input.",
					"/app/output/mutation.report.json was not created.",
					"Please provide a corrected config.",
					"Wrote the report; no contradictions found.",
				].join("\n"),
			),
		).toEqual([
			"Checked the VCF; the reference build in the config contradicts the input.",
			"/app/output/mutation.report.json was not created.",
			"Please provide a corrected config.",
		]);
		expect(
			admittedUnfinished("Done: wrote /results/out.csv; tests pass."),
		).toEqual([]);
		expect(UNATTENDED_RUN_INSTRUCTIONS).toContain(
			"Never stop on an apparent contradiction or a missing input",
		);
		// Only the operating condition: no rule derived from a grader's failures.
		expect(UNATTENDED_RUN_INSTRUCTIONS).not.toMatch(
			/irreversible|outrank|established meaning|co-adjusted|speed or ratio/,
		);
	});

	it("ignores answers that say nothing is unverified", () => {
		expect(
			admittedUnverified(
				"Done; all checks pass.\nUnverified: none.\nNothing is left unverified.\n- Remaining risks: none",
			),
		).toEqual([]);
	});

	it("keeps the builder block general", () => {
		expect(RIGOR_BUILDER_INSTRUCTIONS).toContain(
			"Prefer the convention of the library, ecosystem or standard involved, even over a stricter or more literal reading; take the strictest reading only when no convention applies.",
		);
		expect(RIGOR_BUILDER_INSTRUCTIONS).toContain(
			"an item the list does not name for a slot cannot fill it, even if it carries the same facts",
		);
		expect(RIGOR_BUILDER_INSTRUCTIONS).toContain(
			"run the deliverable as an outside user would",
		);
		expect(RIGOR_BUILDER_INSTRUCTIONS).toContain(
			"Reproduce it using only the existing calls a normal caller would make, and see it fail before your fix and pass after. A fix that needs callers to adopt a new method, protocol or extra calls does not fix that symptom",
		);
		expect(RIGOR_BUILDER_INSTRUCTIONS).toContain(
			"Never declare a reported symptom unresolvable while time remains.",
		);
	});

	it("reads the last requirements block of a text, one clipped item per line", () => {
		expect(requirementsFromText("No list here.")).toBeNull();
		expect(
			requirementsFromText(
				"Plan.\n<requirements>\n- old\n</requirements>\nRevised:\n<requirements>\n- writes out.json\n2. sorted by id (reading: ascending)\n\n* exit 0\n</requirements>",
			),
		).toEqual([
			"writes out.json",
			"sorted by id (reading: ascending)",
			"exit 0",
		]);
		const long = Array.from({ length: 40 }, (_, i) => `- item ${i}`).join("\n");
		expect(
			requirementsFromText(`<requirements>\n${long}\n</requirements>`),
		).toHaveLength(MAX_BUILDER_REQUIREMENTS);
	});

	it("takes the builder's latest list since the person's request", () => {
		const user = (id: string, text: string): SessionItem => ({
			kind: "userMessage",
			id: SessionItemId(id),
			text,
		});
		const agent = (id: string, text: string): SessionItem => ({
			kind: "agentMessage",
			id: SessionItemId(id),
			text,
		});
		const list = (item: string) => `<requirements>\n- ${item}\n</requirements>`;
		expect(
			builderRequirements([
				user("u1", "first request"),
				agent("a1", list("from the first request")),
				user("u2", "second request"),
				agent("a2", "working"),
			]),
		).toBeNull();
		expect(
			builderRequirements([
				user("u1", "request"),
				agent("a1", list("first reading")),
				agent("a2", list("revised reading")),
				agent("a3", "Done."),
			]),
		).toEqual(["revised reading"]);
	});

	it("asks for the list in the message, never in a file", () => {
		expect(RIGOR_REQUIREMENTS_INSTRUCTIONS).toContain(
			"between a <requirements> line and a </requirements> line, never in a file",
		);
		expect(RIGOR_REQUIREMENTS_INSTRUCTIONS).toContain(
			"Mark an ambiguous item with the reading you chose.",
		);
	});
});

describe("requirementsSegments", () => {
	it("splits a message around its requirements block, also while it streams", () => {
		expect(
			requirementsSegments(
				"Plan:\n<requirements>\n- a\n2. b\n</requirements>\nGo.",
			),
		).toEqual([
			{ kind: "text", text: "Plan:\n" },
			{ kind: "requirements", items: ["a", "b"] },
			{ kind: "text", text: "\nGo." },
		]);
		expect(requirementsSegments("<requirements>\n- a\n- b")).toEqual([
			{ kind: "requirements", items: ["a", "b"] },
		]);
		expect(requirementsSegments("No list.")).toEqual([
			{ kind: "text", text: "No list." },
		]);
	});
});

it("never lets an unattended run close a reported problem as intended", () => {
	expect(UNATTENDED_RUN_INSTRUCTIONS).toContain(
		"is never resolved by calling the current behavior intended",
	);
});
