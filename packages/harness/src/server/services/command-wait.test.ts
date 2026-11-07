import { describe, expect, it } from "vitest";
import { type CommandWaitObservation, waitForCommand } from "./command-wait";

/** A fake clock where each guest observation takes the seconds it was asked to wait. */
function guest(
	states: (elapsedSeconds: number) => CommandWaitObservation,
	options: { exitsAt?: number } = {},
) {
	let clock = 0;
	const asked: number[] = [];
	return {
		asked,
		now: () => clock,
		observe: async (seconds: number) => {
			asked.push(seconds);
			const elapsed = clock / 1000;
			const exitIn =
				options.exitsAt === undefined
					? Number.POSITIVE_INFINITY
					: options.exitsAt - elapsed;
			clock += Math.min(seconds, Math.max(0, exitIn)) * 1000;
			return clock / 1000 >= (options.exitsAt ?? Number.POSITIVE_INFINITY)
				? { status: 0 }
				: states(clock / 1000);
		},
	};
}

const growing = (elapsed: number): CommandWaitObservation => ({
	status: "running",
	outputBytes: elapsed,
});

describe("waitForCommand", () => {
	it("returns as soon as the command exits", async () => {
		const fake = guest(growing, { exitsAt: 47 });
		const result = await waitForCommand({
			...fake,
			seconds: 300,
			signal: new AbortController().signal,
		});
		expect(result).toEqual({ reason: "exited", waitedSeconds: 47 });
		expect(fake.asked).toEqual([20, 20, 20]);
	});

	it("stops after the requested seconds while the command keeps running", async () => {
		const fake = guest(growing);
		expect(
			await waitForCommand({
				...fake,
				seconds: 45,
				signal: new AbortController().signal,
			}),
		).toEqual({ reason: "elapsed", waitedSeconds: 45 });
		expect(fake.asked).toEqual([20, 20, 5]);
	});

	it("never waits past the step's deadline", async () => {
		const fake = guest(growing);
		expect(
			await waitForCommand({
				...fake,
				seconds: 600,
				deadlineAt: 50_000,
				signal: new AbortController().signal,
			}),
		).toEqual({ reason: "deadline", waitedSeconds: 50 });
		expect(fake.asked).toEqual([20, 20, 10]);
	});

	it("only peeks once when the deadline already passed", async () => {
		const fake = guest(growing);
		expect(
			await waitForCommand({
				...fake,
				seconds: 300,
				deadlineAt: -1,
				signal: new AbortController().signal,
			}),
		).toEqual({ reason: "deadline", waitedSeconds: 0 });
		expect(fake.asked).toEqual([0]);
	});

	it("returns early when output stops growing", async () => {
		const fake = guest((elapsed) => ({
			status: "running",
			outputBytes: Math.min(elapsed, 40),
		}));
		expect(
			await waitForCommand({
				...fake,
				seconds: 600,
				stallSeconds: 120,
				signal: new AbortController().signal,
			}),
		).toEqual({ reason: "stalled", waitedSeconds: 160 });
	});

	it("keeps waiting on a silent command until the stall bound", async () => {
		const fake = guest(() => ({ status: "running", outputBytes: 0 }));
		expect(
			await waitForCommand({
				...fake,
				seconds: 600,
				signal: new AbortController().signal,
			}),
		).toEqual({ reason: "stalled", waitedSeconds: 180 });
	});

	it("rejects promptly when the turn is cancelled mid-wait", async () => {
		const controller = new AbortController();
		const pending = waitForCommand({
			observe: () => new Promise(() => {}),
			seconds: 300,
			signal: controller.signal,
		});
		controller.abort(new Error("Stopped by user."));
		await expect(pending).rejects.toThrow("Stopped by user.");
	});

	it("does not observe after an earlier cancellation", async () => {
		const controller = new AbortController();
		controller.abort(new Error("Stopped by user."));
		const fake = guest(growing);
		await expect(
			waitForCommand({ ...fake, seconds: 300, signal: controller.signal }),
		).rejects.toThrow("Stopped by user.");
		expect(fake.asked).toEqual([]);
	});
});
