import { SessionItemId } from "./ids";
import type { SessionItem } from "./session-item";

export type AgentTodo = {
	readonly text: string;
	readonly status: "pending" | "in_progress" | "completed";
};

/** The builder's step-list tool (src/server/services/plan-tool.ts); not plan mode's propose_plan. */
export const PLAN_TOOL = "update_plan";

/**
 * An accepted update_plan call as the turn's checklist: one plan item per
 * turn, replaced in place by each update, so the
 * chat shows a single live checklist and the overview its latest state.
 */
export function applyPlanUpdate(
	items: readonly SessionItem[],
	turnId: string,
	update: {
		readonly explanation?: string;
		readonly plan: readonly {
			readonly step: string;
			readonly status: AgentTodo["status"];
		}[];
	},
): SessionItem[] {
	const id = SessionItemId(`${turnId}:plan`);
	const next: SessionItem = {
		kind: "plan",
		id,
		text: update.explanation ?? "",
		todos: update.plan.map(({ step, status }) => ({ text: step, status })),
	};
	return items.some((item) => item.id === id)
		? items.map((item) => (item.id === id ? next : item))
		: [...items, next];
}
