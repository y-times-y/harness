import { CODE_MODE_TOOL, codeModeResult } from "./code-mode";
import type { DynamicToolCallItem, SessionItem } from "./session-item";

/** The agent locks edits with this tool; they stay locked until the user approves. */
export const ENTER_PLAN_MODE_TOOL = "enter_plan_mode";
/** The agent submits its plan with this tool; the turn ends and waits for the user. */
export const PROPOSE_PLAN_TOOL = "propose_plan";
export const PLAN_TEXT_LIMIT = 20_000;

export type AgentPlanState =
	/** No plan in progress: the agent may edit. */
	| { readonly kind: "none" }
	/** The agent entered plan mode during the current turn and has not proposed yet. */
	| { readonly kind: "planning" }
	/** A proposed plan waits for the user; any reply without approval asks for a revision. */
	| { readonly kind: "proposed"; readonly planId: SessionItem["id"] };

/**
 * Where planning stands before the next step or turn, from the transcript alone.
 * A proposed plan stays until it is approved; other replies are feedback on it.
 * Entering plan mode locks only the turn that entered it: a turn that ended
 * without proposing (stopped, failed, or the agent never proposed) shows the
 * user nothing to approve, so it must not lock the turns after it.
 */
export function agentPlanState(items: readonly SessionItem[]): AgentPlanState {
	let laterTurn = false;
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (item.kind === "userMessage") {
			// Chats from before plans were approved in words.
			if (item.approvesPlan) return { kind: "none" };
			laterTurn = true;
		}
		if (item.kind === "planProposal")
			return { kind: "proposed", planId: item.id };
		if (!laterTurn && item.kind === "dynamicToolCall" && entersPlanMode(item))
			return { kind: "planning" };
	}
	return { kind: "none" };
}

/** A completed call of `tool`, direct or inside a run_code program (code mode primary). */
function completes(item: DynamicToolCallItem, tool: string) {
	if (item.tool === tool) return item.status === "completed";
	return (
		item.tool === CODE_MODE_TOOL &&
		(codeModeResult(item)?.calls ?? []).some(
			(call) => call?.tool === tool && call.status === "completed",
		)
	);
}

const entersPlanMode = (item: DynamicToolCallItem) =>
	completes(item, ENTER_PLAN_MODE_TOOL);

/** The plan that still waits for the user's approval, if any. */
export function pendingPlanId(items: readonly SessionItem[]) {
	const state = agentPlanState(items);
	return state.kind === "proposed" ? state.planId : null;
}
