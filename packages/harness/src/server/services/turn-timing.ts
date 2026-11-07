import { AsyncLocalStorage } from "node:async_hooks";

/**
 * One compact JSON log line per durable model step: when each phase of the
 * step was first reached, in ms from the step's start (its claim), so the
 * time from "running" to the first token can be attributed on a deployed
 * edge. Ids, phase names, numbers and fixed reason codes only: no user
 * content, model output, paths or secrets. Marks are synchronous and never
 * awaited; the line is written once, when the step ends.
 */

/** Why a first step's first model request did or did not go out before its workspace. */
export type EarlyRequestReason =
	| "early"
	| "not-first-step"
	| "resumed"
	| "not-root-builder"
	| "evaluation"
	| "harness-variant"
	| "not-lean-surface"
	| "workspace-ready"
	| "no-reported-directory"
	| "hook-config-unknown"
	/** The chat's baseline is known but no step journaled its configuration. */
	| "hook-config-unjournaled"
	/** A new chat whose checkout commit is not pinned before its VM is ready. */
	| "hook-config-no-pinned-base"
	/** The pinned commit's configuration could not be read from GitHub. */
	| "hook-config-unreadable"
	| "prompt-hook-configured";

export type TurnTimingRecord = {
	turnId: string;
	step: number;
	/** Epoch ms the step started (its claim). */
	startedAt: number;
	/** Epoch ms the turn was queued (the send), when known. */
	queuedAt?: number;
	early?: boolean;
	earlyReason?: EarlyRequestReason;
	outcome?: string;
	/** Phase name to ms from startedAt, in the order first reached. */
	phases: Record<string, number>;
};

export function turnTimingLine(record: TurnTimingRecord): string {
	return JSON.stringify({
		ytimesy: "turn-timing",
		turn: record.turnId,
		step: record.step,
		...(record.queuedAt !== undefined && Number.isFinite(record.queuedAt)
			? {
					queuedMs: Math.max(0, Math.round(record.startedAt - record.queuedAt)),
				}
			: {}),
		...(record.early !== undefined ? { early: record.early } : {}),
		...(record.earlyReason ? { earlyReason: record.earlyReason } : {}),
		...(record.outcome ? { outcome: record.outcome } : {}),
		phases: record.phases,
	});
}

export function turnTiming(input: {
	turnId: string;
	step: number;
	startedAt: number;
	queuedAt?: number;
	now?: () => number;
}) {
	const now = input.now ?? Date.now;
	const record: TurnTimingRecord = {
		turnId: input.turnId,
		step: input.step,
		startedAt: input.startedAt,
		queuedAt: input.queuedAt,
		phases: {},
	};
	let written = false;
	return {
		/** The first time a phase is reached; later marks of it are ignored. */
		mark(phase: string) {
			if (phase in record.phases) return;
			record.phases[phase] = Math.max(0, Math.round(now() - input.startedAt));
		},
		early(taken: boolean, reason: EarlyRequestReason) {
			if (record.earlyReason) return;
			record.early = taken;
			record.earlyReason = reason;
		},
		/** Writes the step's line once. */
		write(outcome: string, log: (line: string) => void = console.log) {
			if (written) return;
			written = true;
			record.outcome = outcome;
			record.phases.end ??= Math.max(0, Math.round(now() - input.startedAt));
			log(turnTimingLine(record));
		},
	};
}

export type TurnTiming = ReturnType<typeof turnTiming>;

/** The running durable step's mark function, for code below it that has no handle on the timing. */
const activeMarks = new AsyncLocalStorage<(phase: string) => void>();

/** Runs a step's work so model and egress code under it can mark phases (markTurnPhase). */
export function withTurnTimingMarks<T>(
	mark: (phase: string) => void,
	run: () => Promise<T>,
) {
	return activeMarks.run(mark, run);
}

/** Marks a phase of the running durable step; a no-op outside one. */
export function markTurnPhase(phase: string) {
	activeMarks.getStore()?.(phase);
}

/**
 * A model provider's fetch that marks, for the running durable step, when its
 * first request started (modelFetchStarted), when response headers arrived
 * (modelHeaders) and when the first body byte (the first SSE bytes) arrived
 * (modelFirstByte). With firstToken, network time and model time separate.
 * Outside a durable step it is the fetch it wraps, untouched.
 */
export function timedModelFetch(fetch: typeof globalThis.fetch) {
	const timed: typeof globalThis.fetch = async (input, init) => {
		const mark = activeMarks.getStore();
		if (!mark) return fetch(input, init);
		mark("modelFetchStarted");
		const response = await fetch(input, init);
		mark("modelHeaders");
		if (!response.body) return response;
		let seen = false;
		const body = response.body.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, controller) {
					if (!seen) {
						seen = true;
						mark("modelFirstByte");
					}
					controller.enqueue(chunk);
				},
			}),
		);
		return new Response(body, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	};
	return timed;
}
