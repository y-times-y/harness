import { expect, it } from "vitest";
import { agentPlanState, pendingPlanId } from "./agent-plan";
import { applyApiProgress } from "./api-progress";
import { SessionItemId } from "./ids";
import type { SessionItem } from "./session-item";

const user = (id: string, approvesPlan = false): SessionItem => ({
	kind: "userMessage",
	id: SessionItemId(id),
	text: approvesPlan ? "Approved. Implement the plan." : "Rework billing",
	...(approvesPlan ? { approvesPlan: true as const } : {}),
});
const plan = (id: string): SessionItem => ({
	kind: "planProposal",
	id: SessionItemId(id),
	text: "1. Split invoices",
});
const entered: SessionItem = {
	kind: "dynamicToolCall",
	id: SessionItemId("t1:enter"),
	tool: "enter_plan_mode",
	status: "completed",
};

it("is off until the agent enters plan mode", () => {
	expect(agentPlanState([user("u1")])).toEqual({ kind: "none" });
	expect(agentPlanState([user("u1"), entered])).toEqual({ kind: "planning" });
});

it("keeps a proposed plan from an old chat waiting until its approve flag", () => {
	const proposed = [user("u1"), entered, plan("t1:p")];
	expect(agentPlanState(proposed)).toEqual({
		kind: "proposed",
		planId: "t1:p",
	});
	expect(pendingPlanId([...proposed, user("u2")])).toBe("t1:p");
});

it("still honours the approve flag of chats from before plans were approved in words", () => {
	expect(
		agentPlanState([user("u1"), entered, plan("t1:p"), user("u2", true)]),
	).toEqual({ kind: "none" });
});

it("lifts a plan mode entered by a turn that ended without proposing", () => {
	// Stopped or failed after enter_plan_mode: the user has nothing to approve.
	expect(agentPlanState([user("u1"), entered, user("u2")])).toEqual({
		kind: "none",
	});
	// A plan proposed earlier still waits for approval.
	expect(
		agentPlanState([user("u1"), plan("t1:p"), user("u2"), entered, user("u3")]),
	).toEqual({ kind: "proposed", planId: "t1:p" });
});

it("records propose_plan as a plan item, not a tool row, once it succeeded", () => {
	const called = applyApiProgress([user("u1")], "t1", {
		type: "tool-call",
		id: "c1",
		name: "propose_plan",
		input: { plan: "  ## Plan\n1. Split invoices  " },
	});
	// The call alone proposes nothing: validation or a hook may still reject it.
	expect(called).toEqual([user("u1")]);
	const proposed = applyApiProgress(called, "t1", {
		type: "tool-result",
		id: "c1",
		name: "propose_plan",
		output: { proposed: true, plan: "  ## Plan\n1. Split invoices  " },
	});
	expect(proposed.at(-1)).toEqual({
		kind: "planProposal",
		id: "t1:c1",
		text: "## Plan\n1. Split invoices",
	});
	expect(pendingPlanId(proposed)).toBe("t1:c1");
	for (const rejected of [
		{ output: "Invalid input for tool propose_plan", failed: true },
		{ output: { blocked: true, error: "Blocked by a hook" } },
		{ output: { proposed: true, plan: " " } },
	])
		expect(
			pendingPlanId(
				applyApiProgress(called, "t1", {
					type: "tool-result",
					id: "c1",
					name: "propose_plan",
					...rejected,
				}),
			),
		).toBeNull();
});

it("counts plan mode entered from inside a run_code program (code mode primary)", () => {
	const program = (status: "completed" | "failed"): SessionItem => ({
		kind: "dynamicToolCall",
		id: SessionItemId("t1:code"),
		tool: "run_code",
		status: "completed",
		output: JSON.stringify({
			ok: true,
			calls: [
				{ tool: "read", input: "{}", status: "completed", ms: 1, output: "" },
				{
					tool: "enter_plan_mode",
					input: "{}",
					status,
					ms: 1,
					output: "",
				},
			],
		}),
	});
	expect(agentPlanState([user("u1"), program("completed")])).toEqual({
		kind: "planning",
	});
	expect(agentPlanState([user("u1"), program("failed")])).toEqual({
		kind: "none",
	});
	expect(
		agentPlanState([user("u1"), program("completed"), user("u2")]),
	).toEqual({ kind: "none" });
});
