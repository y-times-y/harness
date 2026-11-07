import { z } from "zod";

/**
 * A backstop against a model looping forever, not a limit on real work: usage
 * limits and per-step token admission are what bound spend. A turn has no
 * wall-clock deadline; a dead or hung one is caught by its heartbeat.
 */
const IMPLEMENTATION_MODEL_STEPS = 1000;
export const MAX_WORKFLOW_MODEL_STEPS = IMPLEMENTATION_MODEL_STEPS;

/** One durable step must finish inside a single alarm, which the hosting platform stops after 15 minutes. */
export const STEP_BUDGET_MS = 14 * 60 * 1000;
/** After this a step waiting on its model call, with no tool started, ends and continues in the next step. */
export const STEP_SOFT_DEADLINE_MS = 12 * 60 * 1000;
/** How long a token minted for one step stays valid: the step's budget and a margin. */
export const STEP_TOKEN_TTL_MS = STEP_BUDGET_MS + 15 * 60 * 1000;

/** More tool iterations do not bypass token admission. */
export function modelStepLimit() {
	return IMPLEMENTATION_MODEL_STEPS;
}
export const workflowTurnSchema = z
	.object({
		turnId: z.uuid(),
		leaseId: z.uuid(),
	})
	.strict();
export const workflowStepSchema = workflowTurnSchema.extend({
	index: z
		.number()
		.int()
		.min(1)
		.max(MAX_WORKFLOW_MODEL_STEPS + 1),
});
export type WorkflowTurn = z.infer<typeof workflowTurnSchema>;
export type WorkflowStep = z.infer<typeof workflowStepSchema>;
export type WorkflowStepOutcome =
	| "continue"
	| "completed"
	| "failed"
	| "cancelled";
