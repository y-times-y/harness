import {
	USAGE_CEILING_REFUSAL_PATTERN,
	USAGE_WINDOW_REFUSAL_PATTERN,
} from "./infrastructure-usage";

const GENERIC_EFFECT_PROMISE_FAILURE =
	"An unknown error occurred in Effect.tryPromise";

export function failureMessage(cause: unknown): string {
	const message = unwrapFailureMessage(cause, new Set());
	return (
		(message && usageCapFailureMessage(message)) ||
		message ||
		"Something went wrong."
	);
}

export const USER_USAGE_CAP_MESSAGE =
	"You have reached your cloud usage limit, so new machine time cannot start. Your work is preserved; the limit refills over the next hours (see Settings for the exact time).";
export const FLEET_MONTHLY_CAP_MESSAGE =
	"The shared cloud budget for this month has been used, so new machine time cannot start. Your work is preserved; the budget resets on the 1st (UTC).";
export const FLEET_LIFETIME_CAP_MESSAGE =
	"The shared cloud budget has been used, so new machine time cannot start. Your work is preserved; capacity will reopen as soon as possible.";

/**
 * The user-facing wording for a usage cap refusal (src/server/adapters/
 * infrastructure-usage.ts), or null when the text is not one. Fleet caps are
 * the beta's shared budget, not something the user did or can fix.
 */
export function usageCapFailureMessage(message: string): string | null {
	const window = USAGE_WINDOW_REFUSAL_PATTERN.exec(message);
	if (window) return window[0];
	const ceiling = USAGE_CEILING_REFUSAL_PATTERN.exec(message);
	if (ceiling) return ceiling[0];
	if (/lifetime fleet cloud execution budget is exhausted/i.test(message))
		return FLEET_LIFETIME_CAP_MESSAGE;
	if (/fleet cloud execution budget is exhausted/i.test(message))
		return FLEET_MONTHLY_CAP_MESSAGE;
	if (/your cloud execution allowance is exhausted/i.test(message))
		return USER_USAGE_CAP_MESSAGE;
	return null;
}

export function workspaceLooksGone(message: string): boolean {
	if (/codex binary not found/i.test(message)) return false;
	return /not found|404|does not exist|unknown vm|no such (?:workspace|vm|machine)|deleted/i.test(
		message,
	);
}

export function isWorkspaceAtCapacity(message: string) {
	return /LIMIT_EXCEEDED|limit of \d+ VMs|at its VM limit|at its limit|Pausing a VM does not free a slot|Pausing does not free a slot/i.test(
		message,
	);
}

export function isWorkspaceComputeAllowanceExhausted(message: string) {
	return /allowance for vcpu_time|memory_time has been used|compute allowance|vCPU-hour allowance/i.test(
		message,
	);
}

function unwrapFailureMessage(cause: unknown, seen: Set<unknown>): string {
	if (cause == null) return "";
	if (typeof cause === "string") {
		const text = cause.trim();
		return text === GENERIC_EFFECT_PROMISE_FAILURE ? "" : text;
	}
	if (typeof cause !== "object") return "";
	if (seen.has(cause)) return "";
	seen.add(cause);
	const record = cause as {
		error?: unknown;
		cause?: unknown;
		message?: unknown;
	};
	const nested = unwrapFailureMessage(record.error, seen);
	if (nested) return nested;
	const innerCause = unwrapFailureMessage(record.cause, seen);
	if (innerCause) return innerCause;
	if (typeof record.message === "string") {
		const text = record.message.trim();
		if (text && text !== GENERIC_EFFECT_PROMISE_FAILURE) return text;
	}
	return "";
}
