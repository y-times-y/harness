import { leanToolNames } from "./harness-model-profile";
import { SessionItemId } from "./ids";
import type {
	NoticeSessionItem,
	SessionItem,
	SessionTurnStatus,
} from "./session-item";

/** Lean tools that only read the checkout (or an image in it). */
const READ_ONLY_TOOLS = new Set<string>(
	leanToolNames(["read", "glob", "grep", "image"]),
);

/**
 * Whether this turn ran a tool that could have changed the workspace, read
 * from its own cards (ids `<turnId>:…`). Conservative: any command, file
 * change, MCP call or tool call counts, except the lean read-only tools. A
 * turn that only answered (plan proposals, questions and web searches
 * included) has nothing to commit.
 */
export function turnMayHaveChangedWorkspace(
	items: readonly SessionItem[],
	turnId: string,
): boolean {
	const own = `${turnId}:`;
	return items.some((item) => {
		if (!item.id.startsWith(own)) return false;
		switch (item.kind) {
			case "commandExecution":
			case "fileChange":
			case "mcpToolCall":
				return true;
			case "dynamicToolCall":
				return !READ_ONLY_TOOLS.has(item.tool);
			default:
				return false;
		}
	});
}

const SAVING_CHANGES_SUFFIX = ":saving-changes";

export const SAVING_CHANGES_TEXT = "Saving changes…";

/**
 * Shown after the final answer while the turn commits its changes: the
 * answer is done, so the composer offers Send (it waits for the commit)
 * instead of Stop. Removed before the turn is marked done.
 */
export function savingChangesItem(turnId: string): NoticeSessionItem {
	return {
		kind: "notice",
		id: SessionItemId(`${turnId}${SAVING_CHANGES_SUFFIX}`),
		message: SAVING_CHANGES_TEXT,
		savingChanges: true,
	};
}

export function withoutSavingChanges(
	items: readonly SessionItem[],
): SessionItem[] {
	return items.filter(
		(item) => !(item.kind === "notice" && item.savingChanges),
	);
}

/** The running turn has answered and only saves its changes now. */
export function turnSavingChanges(
	items: readonly SessionItem[],
	turnStatus: SessionTurnStatus,
): boolean {
	if (turnStatus !== "running") return false;
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (item.kind === "notice" && item.savingChanges) return true;
		// Messages sent meanwhile wait after it.
		if (item.kind === "userMessage" && item.queued) continue;
		return false;
	}
	return false;
}
