import { z } from "zod";
import type { SessionItem } from "./session-item";

/**
 * The git proxy refuses a workspace push to a repository's default branch
 * unless the project allows it; the refusal tells the agent to call this
 * tool, which posts a Push / Cancel card for that exact commit and returns
 * at once: the agent keeps working, and the user's Push pushes server-side.
 */
export const REQUEST_PUSH_APPROVAL_TOOL = "request_push_approval";

export const PUSH_SUMMARY_LIMIT = 300;

/** An unanswered card can be pushed this long after it was posted. */
export const PUSH_CARD_LIFETIME_MS = 24 * 60 * 60_000;

/** What the agent reads once the card is posted; the turn goes on. */
export const PUSH_APPROVAL_REQUESTED_NOTE =
	"Approval requested; continue with any work that does not need main updated. If nothing is left, finish your turn and say the push waits for approval.";

/** What the card shows and the user approves: one refused push. */
export const pushApprovalRequest = z.object({
	/** The refused push's git_push_request row. */
	requestId: z.uuid(),
	/** owner/name */
	repo: z.string().min(3).max(201),
	branch: z.string().min(1).max(255),
	/** Commits the push adds to the branch; null when the workspace could not count them. */
	commits: z.number().int().nonnegative().nullable(),
	summary: z.string().max(PUSH_SUMMARY_LIMIT),
});
export type PushApprovalRequest = z.infer<typeof pushApprovalRequest>;

/** The tool's output when it showed a card; a refused call stays a tool call. */
export function requestedPushApproval(
	output: unknown,
	failed: boolean | undefined,
): PushApprovalRequest | null {
	if (failed) return null;
	const value = output as { requested?: unknown } | null;
	if (value?.requested !== true) return null;
	const parsed = pushApprovalRequest.safeParse(output);
	return parsed.success ? parsed.data : null;
}

/** The card's question, e.g. "Push 3 commits to main on acme/app?". */
export function pushApprovalQuestion(request: PushApprovalRequest) {
	const commits =
		request.commits === null
			? "these commits"
			: `${request.commits} ${request.commits === 1 ? "commit" : "commits"}`;
	return `Push ${commits} to ${request.branch} on ${request.repo}?`;
}

/** How a card ended; kept on its git_push_request row and in the chat's notice. */
export const PUSH_ANSWERS = [
	"pushed",
	"failed",
	"cancelled",
	"outdated",
	"expired",
] as const;
export type PushAnswer = (typeof PUSH_ANSWERS)[number];

/** A card's answer: `detail` is the short sha when pushed, else the one-line reason. */
export type PushResult = {
	readonly requestId: string;
	readonly answer: PushAnswer;
	readonly detail: string;
};

/** What a card shows: waiting, or its answer. */
export type PushCardState =
	| { readonly answer: "pending" }
	| Omit<PushResult, "requestId">;

/** The card's one line for an answer. */
export function pushAnswerLine(
	branch: string,
	result: Omit<PushResult, "requestId">,
) {
	switch (result.answer) {
		case "pushed":
			return `Pushed to ${branch} (${result.detail})`;
		case "cancelled":
			return "Cancelled";
		case "expired":
			return "Expired. Ask again to push.";
		case "outdated":
			return `Outdated: ${result.detail}`;
		case "failed":
			return `Not pushed: ${result.detail}`;
	}
}

/** The chat's notice once a card is answered: what the agent and the user read. */
export function pushResultNotice(
	request: { repo: string; branch: string },
	result: Omit<PushResult, "requestId">,
) {
	const where = `${request.branch} on ${request.repo}`;
	switch (result.answer) {
		case "pushed":
			return `The user approved the push: ${result.detail} is now on ${where}.`;
		case "cancelled":
			return `The user cancelled the push to ${where}; leave the work on its branch or pull request.`;
		case "expired":
			return `The push request for ${where} expired unanswered.`;
		case "outdated":
			return `The push request for ${where} is outdated (${result.detail}); request approval again for the current commit if it is still needed.`;
		case "failed":
			return `The approved push to ${where} failed and nothing was pushed: ${result.detail}`;
	}
}

/** A card's answer from the transcript: its notice, else still pending. */
export function pushApprovalOutcome(
	items: readonly SessionItem[],
	itemId: SessionItem["id"],
): PushCardState {
	const card = items.find((item) => item.id === itemId);
	if (card?.kind !== "pushApproval") return { answer: "pending" };
	for (const item of items)
		if (item.kind === "notice" && item.pushResult?.requestId === card.requestId)
			return { answer: item.pushResult.answer, detail: item.pushResult.detail };
	return { answer: "pending" };
}
