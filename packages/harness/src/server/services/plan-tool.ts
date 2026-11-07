import { type ToolSet, tool } from "ai";
import { z } from "zod";
import { PLAN_TOOL } from "../../domain/agent-todos";

export { PLAN_TOOL };

export const PLAN_STEP_STATUSES = [
	"pending",
	"in_progress",
	"completed",
] as const;
export type PlanStepStatus = (typeof PLAN_STEP_STATUSES)[number];
export type PlanStep = {
	readonly step: string;
	readonly status: PlanStepStatus;
};

/** One accepted update: the whole list as the agent sent it. */
export type PlanUpdate = {
	readonly at: string;
	readonly explanation?: string;
	readonly plan: readonly PlanStep[];
};

const MAX_STEPS = 30;
const MAX_STEP_CHARACTERS = 300;

const planInput = z.object({
	explanation: z
		.string()
		.max(1_000)
		.optional()
		.describe("Why the plan changed, in a sentence (optional)"),
	plan: z
		.array(
			z.object({
				step: z.string().min(1).max(MAX_STEP_CHARACTERS),
				status: z.enum(PLAN_STEP_STATUSES),
			}),
		)
		.min(1)
		.max(MAX_STEPS)
		.describe("The full list of steps, in order"),
});

/** Counts per status, e.g. "2 completed, 1 in progress, 3 pending". */
export function planSummary(plan: readonly PlanStep[]) {
	const count = (status: PlanStepStatus) =>
		plan.filter((entry) => entry.status === status).length;
	return [
		`${count("completed")} completed`,
		`${count("in_progress")} in progress`,
		`${count("pending")} pending`,
	].join(", ");
}

/**
 * update_plan, in the common shape: the agent sends its whole step list with
 * each step pending, in_progress or completed; the harness keeps every
 * update (for the trace and the chat card) and answers with a one-line
 * summary. The plan is the agent's own note: nothing is enforced but at
 * most one step in progress. The description depends on nothing, so it is
 * byte-stable across steps and runs.
 */
export function planTool(input: {
	now: () => number;
	onUpdate: (update: PlanUpdate) => void;
}): ToolSet {
	return {
		[PLAN_TOOL]: tool({
			description:
				"Keep a short plan for long, multi-part work (about 20 steps or more): send the full list of steps, each pending, in_progress or completed, with at most one in_progress. Never call it on its own: send it in the same response as your next tool call (or inside run_code), so it costs no extra step. Update it only when a step finishes or the plan changes, without an explanation. Skip it for shorter work.",
			inputSchema: planInput,
			execute: async ({ explanation, plan }) => {
				const active = plan.filter(
					(entry) => entry.status === "in_progress",
				).length;
				if (active > 1)
					return `Plan not updated: ${active} steps are in_progress; keep at most one.`;
				input.onUpdate({
					at: new Date(input.now()).toISOString(),
					...(explanation?.trim() ? { explanation: explanation.trim() } : {}),
					plan,
				});
				return `Plan updated: ${planSummary(plan)}.`;
			},
		}),
	};
}
