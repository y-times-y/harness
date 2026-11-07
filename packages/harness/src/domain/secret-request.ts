import type { SecretRequestItem, SessionItem } from "./session-item";

/**
 * The agent asks the user for project secrets with this tool; the turn ends and
 * the chat shows one card with a field per secret, where the user pastes the
 * values they have and skips the rest. Values go straight to project settings,
 * never through the model or the transcript.
 */
export const REQUEST_PROJECT_SECRET_TOOL = "request_project_secret";

/** Kinds the agent can ask for; build secrets only reach environment setup. */
export const REQUESTABLE_SECRET_KINDS = ["runtime", "environment"] as const;
export type RequestableSecretKind = (typeof REQUESTABLE_SECRET_KINDS)[number];

export const SECRET_REASON_LIMIT = 300;

/** Most secrets one request may ask for (a large .env.example has ~60). */
export const SECRET_REQUEST_LIMIT = 64;

/** One secret a request asks for. */
export type RequestedSecret = {
	readonly name: string;
	readonly secretKind: RequestableSecretKind;
	readonly reason: string;
};

/** The secrets a request asks for, whether it carries a list or (older chats) one name. */
export function requestedSecrets(
	item: SecretRequestItem,
): readonly RequestedSecret[] {
	return "secrets" in item
		? item.secrets
		: [{ name: item.name, secretKind: item.secretKind, reason: item.reason }];
}

const list = (names: readonly string[]) => names.join(", ");

/**
 * What the user's reply says once the card is answered; the next turn sees
 * the saved variables. With nothing saved, it is secretsSkippedText.
 */
export function secretsAnsweredText(
	saved: readonly string[],
	skipped: readonly string[] = [],
) {
	if (!saved.length) return secretsSkippedText(skipped);
	return skipped.length
		? `I saved ${list(saved)} to the project's secrets and skipped ${list(skipped)} for now. Continue.`
		: `I saved ${list(saved)} to the project's secrets. Continue.`;
}

export function secretsSkippedText(skipped: readonly string[]) {
	return skipped.length === 1
		? `Skip ${skipped[0]} for now. Continue without it.`
		: `Skip these for now: ${list(skipped)}. Continue without them.`;
}

const ANSWERED =
	/^I saved (.+?) to the project's secrets(?: and skipped (.+?) for now)?\. Continue\.$/;

/** How a secret request was answered, from the transcript alone: provided once any was saved. */
export function secretRequestOutcome(
	items: readonly SessionItem[],
	requestId: SessionItem["id"],
): "pending" | "provided" | "answered" {
	const index = items.findIndex((item) => item.id === requestId);
	const request = items[index];
	if (index < 0 || request?.kind !== "secretRequest") return "answered";
	const reply = items
		.slice(index + 1)
		.find((item) => item.kind === "userMessage");
	if (!reply) return "pending";
	const answer =
		reply.kind === "userMessage" ? ANSWERED.exec(reply.text) : null;
	if (!answer) return "answered";
	// The reply names exactly the secrets this card asked for.
	const named = [answer[1], answer[2]]
		.flatMap((names) => names?.split(", ") ?? [])
		.sort();
	const asked = requestedSecrets(request)
		.map(({ name }) => name)
		.sort();
	return named.join() === asked.join() ? "provided" : "answered";
}
