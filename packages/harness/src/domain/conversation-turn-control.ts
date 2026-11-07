import { z } from "zod";

export const turnControlSchema = z.object({
	userId: z.string().min(1).max(200),
	sessionId: z.string().uuid(),
	turnId: z.string().uuid(),
	leaseId: z.string().uuid(),
});
export type TurnControl = z.infer<typeof turnControlSchema>;
/** Deletes a chat's stored coordination state when the chat, its project or its account goes. */
export const conversationPurgeSchema = turnControlSchema.pick({
	userId: true,
	sessionId: true,
});
export type ActiveConversationTurn = TurnControl & {
	expiresAt: number;
	cancelled: boolean;
};
export const TURN_COORDINATION_LEASE_MS = 30_000;

export type TurnControlAction = "acquire" | "renew" | "release" | "cancel";
type CoordinationFailureReason =
	| { kind: "http"; status: number }
	| { kind: "transport"; category: "timeout" | "network" };

/** Contains only bounded diagnostics, never response bodies, URLs or credentials. */
export class CoordinationFailure extends Error {
	constructor(
		readonly action: TurnControlAction,
		readonly failure: CoordinationFailureReason,
		readonly attempts: number,
	) {
		const reason =
			failure.kind === "http" ? `HTTP ${failure.status}` : failure.category;
		super(
			`Conversation coordination failed during ${action} (${reason}, ${attempts} attempt${attempts === 1 ? "" : "s"}). Execution stopped; inspect preserved work before continuing. No model fallback or stream replay was used.`,
		);
		this.name = "CoordinationFailure";
	}
	get retryable() {
		return (
			this.failure.kind === "transport" ||
			this.failure.status === 429 ||
			this.failure.status >= 500
		);
	}
}
