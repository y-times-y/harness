const MAX_USAGE_MICRO_USD = 1_000_000_000_000;

export function validUsageAmount(amount: number) {
	if (
		!Number.isSafeInteger(amount) ||
		amount < 0 ||
		amount > MAX_USAGE_MICRO_USD
	)
		throw new Error("Invalid infrastructure usage amount.");
	return amount;
}

export function utcUsageMonth(now = new Date()) {
	if (!Number.isFinite(now.getTime())) throw new Error("Invalid usage date.");
	return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

export function infrastructureBalance(input: {
	allowanceMicroUsd: number;
	consumedMicroUsd: number;
	reservedMicroUsd: number;
}) {
	for (const value of Object.values(input)) validUsageAmount(value);
	return {
		...input,
		remainingMicroUsd: Math.max(
			0,
			input.allowanceMicroUsd - input.consumedMicroUsd - input.reservedMicroUsd,
		),
	};
}

/**
 * Per-user VM usage is limited over two rolling windows (like model subscription plans): a short one that refills within hours and a weekly
 * one. Hitting either refuses new work; running work finishes, up to a hard
 * ceiling about an hour of runtime past the limit.
 */
export const USAGE_WINDOWS = [
	{ id: "five_hour", label: "5-hour limit", ms: 5 * 60 * 60 * 1000 },
	{ id: "weekly", label: "Weekly limit", ms: 7 * 24 * 60 * 60 * 1000 },
] as const;
export type UsageWindowId = (typeof USAGE_WINDOWS)[number]["id"];

/** Share of a window at which the user gets a heads-up. */
export const USAGE_WINDOW_WARNING_SHARE = 0.8;

/**
 * One reservation as usage: settled ones count at their settlement, open
 * holds (running machines) count now, at their full held amount.
 */
export type UsageCharge = { at: number; microUsd: number; open: boolean };

export type UsageWindowState = {
	id: UsageWindowId;
	limitMicroUsd: number;
	usedMicroUsd: number;
	usedPercent: number;
	exhausted: boolean;
	/**
	 * When exhausted: the first moment usage falls back under the limit as old
	 * charges leave the window. Otherwise when the oldest counted charge
	 * leaves. Null with nothing counted. Epoch milliseconds.
	 */
	resetsAt: number | null;
};

export function usageWindowState(
	id: UsageWindowId,
	charges: readonly UsageCharge[],
	limitMicroUsd: number,
	now = Date.now(),
): UsageWindowState {
	validUsageAmount(limitMicroUsd);
	const { ms } = USAGE_WINDOWS.find((window) => window.id === id) ?? {
		ms: 0,
	};
	const counted = charges
		.filter((charge) => charge.open || charge.at > now - ms)
		.map((charge) => ({
			at: charge.open ? now : charge.at,
			microUsd: validUsageAmount(charge.microUsd),
		}))
		.sort((a, b) => a.at - b.at);
	const usedMicroUsd = counted.reduce(
		(sum, charge) => sum + charge.microUsd,
		0,
	);
	const exhausted = usedMicroUsd >= limitMicroUsd;
	let resetsAt: number | null = null;
	if (counted.length && !exhausted) resetsAt = counted[0].at + ms;
	else if (counted.length) {
		let remaining = usedMicroUsd;
		for (const charge of counted) {
			remaining -= charge.microUsd;
			resetsAt = charge.at + ms;
			if (remaining < limitMicroUsd) break;
		}
	}
	return {
		id,
		limitMicroUsd,
		usedMicroUsd,
		usedPercent:
			limitMicroUsd > 0
				? Math.min(100, Math.floor((usedMicroUsd * 100) / limitMicroUsd))
				: 100,
		exhausted,
		resetsAt,
	};
}

/** The window that refuses new work now: the one that reopens last. */
export function blockingUsageWindow(windows: readonly UsageWindowState[]) {
	return (
		windows
			.filter((window) => window.exhausted)
			.sort((a, b) => (b.resetsAt ?? 0) - (a.resetsAt ?? 0))[0] ?? null
	);
}

/** "2026-10-20 14:05 UTC": a server message cannot know the reader's zone. */
function utcMinute(ms: number) {
	return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** Fixed wording; failure mapping recognizes it and shows it as is. */
export function usageWindowRefusal(window: UsageWindowState) {
	const which = window.id === "weekly" ? "weekly" : "5-hour";
	return `You have reached your ${which} cloud usage limit, so new work cannot start${window.resetsAt ? ` until ${utcMinute(window.resetsAt)}` : ""}. Work already running finishes, and your work is preserved.`;
}
export const USAGE_WINDOW_REFUSAL_PATTERN =
	/You have reached your (?:5-hour|weekly) cloud usage limit, so new work cannot start(?: until \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC)?\. Work already running finishes, and your work is preserved\./;

export class UsageWindowExhausted extends Error {
	constructor(readonly window: UsageWindowState) {
		super(usageWindowRefusal(window));
		this.name = "UsageWindowExhausted";
	}
}

/**
 * Running work may carry a window past its limit by about this much runtime
 * of the machine buying it, never further: it finishes its turn, but cannot
 * extend indefinitely.
 */
export const USAGE_OVERRUN_SECONDS = 3600;

/** The hard ceiling of a window for a machine costing hourlyMicroUsd. */
export function usageWindowCeiling(
	limitMicroUsd: number,
	hourlyMicroUsd: number,
) {
	validUsageAmount(hourlyMicroUsd);
	return (
		limitMicroUsd + Math.ceil((hourlyMicroUsd * USAGE_OVERRUN_SECONDS) / 3600)
	);
}

/** Fixed wording; failure mapping recognizes it and shows it as is. */
export function usageCeilingRefusal(window: UsageWindowState) {
	const which = window.id === "weekly" ? "weekly" : "5-hour";
	return `Running work has used the grace past your ${which} cloud usage limit, so this machine cannot keep running${window.resetsAt ? ` until ${utcMinute(window.resetsAt)}` : ""}. Your work is preserved.`;
}
export const USAGE_CEILING_REFUSAL_PATTERN =
	/Running work has used the grace past your (?:5-hour|weekly) cloud usage limit, so this machine cannot keep running(?: until \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC)?\. Your work is preserved\./;

export class UsageCeilingReached extends Error {
	constructor(readonly window: UsageWindowState) {
		super(usageCeilingRefusal(window));
		this.name = "UsageCeilingReached";
	}
}
