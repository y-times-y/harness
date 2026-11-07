/** A waiting continue_command returns by itself when the command exits; this is the default bound. */
export const COMMAND_WAIT_DEFAULT_SECONDS = 300;
/** Commands are bounded to ten minutes, so a longer wait could never be useful. */
export const COMMAND_WAIT_MAX_SECONDS = 600;
/** Silent this long, a command may be hung or waiting for input; let the model decide. */
export const COMMAND_WAIT_STALL_SECONDS = 180;
/** Each guest observation waits at most this long, so output growth is sampled regularly. */
const CHUNK_SECONDS = 20;

export type CommandWaitObservation = {
	status: number | "running" | "interrupted";
	/** Size of the command's output so far; unchanged size means no new output. */
	outputBytes?: number;
};

export type CommandWaitResult = {
	/** Why the wait ended: the command finished, the requested wait elapsed, output stopped growing, or the step/turn time left ran out. */
	reason: "exited" | "elapsed" | "stalled" | "deadline";
	waitedSeconds: number;
};

const abortable = <T>(promise: Promise<T>, signal: AbortSignal) =>
	new Promise<T>((resolve, reject) => {
		if (signal.aborted) return reject(signal.reason);
		const stop = () => reject(signal.reason);
		signal.addEventListener("abort", stop, { once: true });
		promise.then(resolve, reject).finally(() => {
			signal.removeEventListener("abort", stop);
		});
	});

/**
 * Waits in the harness, not the model, until an owned command exits, the wait
 * elapses, its output stalls, or `deadlineAt` (the latest moment the tool may
 * still be running, e.g. the end of the step budget minus a margin) arrives.
 * `observe(seconds)` waits up to that many seconds inside the guest for the
 * command to finish and reports its state. Aborting rejects immediately.
 */
export async function waitForCommand(input: {
	observe: (seconds: number) => Promise<CommandWaitObservation>;
	seconds: number;
	signal: AbortSignal;
	deadlineAt?: number;
	stallSeconds?: number;
	chunkSeconds?: number;
	now?: () => number;
}): Promise<CommandWaitResult> {
	const now = input.now ?? Date.now;
	const stallMs = (input.stallSeconds ?? COMMAND_WAIT_STALL_SECONDS) * 1000;
	const chunk = input.chunkSeconds ?? CHUNK_SECONDS;
	const started = now();
	const requestedEnd = started + input.seconds * 1000;
	const end = Math.min(
		requestedEnd,
		input.deadlineAt ?? Number.POSITIVE_INFINITY,
	);
	const result = (reason: CommandWaitResult["reason"]): CommandWaitResult => ({
		reason,
		waitedSeconds: Math.round((now() - started) / 1000),
	});
	let lastBytes: number | undefined;
	let lastGrowth = started;
	for (;;) {
		input.signal.throwIfAborted();
		const left = Math.floor((end - now()) / 1000);
		const seconds = Math.max(0, Math.min(chunk, left));
		const observed = await abortable(input.observe(seconds), input.signal);
		if (observed.status !== "running") return result("exited");
		const at = now();
		// The first sample is the baseline: growth before it is unknown.
		if (lastBytes === undefined) lastBytes = observed.outputBytes;
		else if (observed.outputBytes !== lastBytes) {
			lastBytes = observed.outputBytes;
			lastGrowth = at;
		}
		if (at - lastGrowth >= stallMs) return result("stalled");
		if (at >= end || left <= 0 || seconds === 0)
			return result(at >= requestedEnd ? "elapsed" : "deadline");
	}
}
