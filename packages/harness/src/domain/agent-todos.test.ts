import { expect, it } from "vitest";
import { agentPlanState } from "./agent-plan";
import { shouldPollSubagents } from "./agent-task";
import { applyPlanUpdate } from "./agent-todos";
import { applyApiProgress } from "./api-progress";
import { SessionItemId } from "./ids";
import type { SessionItem } from "./session-item";

it("discovers tasks from an empty list while the lead runs and follows waiting children", () => {
	expect(shouldPollSubagents("running", [])).toBe(true);
	expect(shouldPollSubagents("completed", [{ status: "waiting" }])).toBe(true);
	expect(shouldPollSubagents("completed", [{ status: "done" }])).toBe(false);
});

const asked: SessionItem = {
	kind: "userMessage",
	id: SessionItemId("user"),
	text: "Migrate billing",
};

it("keeps one checklist per turn, replaced in place by each plan update", () => {
	const first = applyPlanUpdate([asked], "turn", {
		plan: [
			{ step: "Read the schema", status: "in_progress" },
			{ step: "Write the migration", status: "pending" },
		],
	});
	const read: SessionItem = {
		kind: "dynamicToolCall",
		id: SessionItemId("turn:read"),
		tool: "read",
		status: "completed",
	};
	const second = applyPlanUpdate([...first, read], "turn", {
		explanation: "Schema read",
		plan: [
			{ step: "Read the schema", status: "completed" },
			{ step: "Write the migration", status: "in_progress" },
		],
	});
	expect(second).toEqual([
		asked,
		{
			kind: "plan",
			id: "turn:plan",
			text: "Schema read",
			todos: [
				{ text: "Read the schema", status: "completed" },
				{ text: "Write the migration", status: "in_progress" },
			],
		},
		read,
	]);
	// The next turn starts its own checklist.
	expect(
		applyPlanUpdate(second, "next", {
			plan: [{ step: "Ship", status: "pending" }],
		}).filter((item) => item.kind === "plan"),
	).toHaveLength(2);
});

it("adds no tool cards for update_plan calls; the checklist item stands for them", () => {
	const called = applyApiProgress([asked], "turn", {
		type: "tool-call",
		id: "call",
		name: "update_plan",
		input: { plan: [{ step: "Ship", status: "pending" }] },
	});
	const answered = applyApiProgress(called, "turn", {
		type: "tool-result",
		id: "call",
		name: "update_plan",
		output: "Plan updated: 0 completed, 0 in progress, 1 pending.",
	});
	expect(answered).toEqual([asked]);
});

it("leaves plan mode alone: propose_plan still waits, a checklist never does", () => {
	const proposed = applyApiProgress([asked], "turn", {
		type: "tool-result",
		id: "propose",
		name: "propose_plan",
		output: { proposed: true, plan: "1. Split invoices" },
	});
	expect(proposed.at(-1)).toEqual({
		kind: "planProposal",
		id: "turn:propose",
		text: "1. Split invoices",
	});
	expect(agentPlanState(proposed)).toEqual({
		kind: "proposed",
		planId: "turn:propose",
	});
	const checklist = applyPlanUpdate([asked], "turn", {
		plan: [{ step: "Ship", status: "in_progress" }],
	});
	expect(agentPlanState(checklist)).toEqual({ kind: "none" });
});
