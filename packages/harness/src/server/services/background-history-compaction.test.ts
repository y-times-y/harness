import type { ModelMessage } from "ai";
import { expect, it, vi } from "vitest";
import { BackgroundHistoryCompaction } from "./background-history-compaction";

const old: ModelMessage[] = [
	{ role: "user", content: "old task" },
	{ role: "assistant", content: "completed evidence" },
];
const checkpoint: ModelMessage[] = [
	{ role: "assistant", content: "checkpoint" },
];
const recent: ModelMessage = { role: "user", content: "live task" };

it("runs without blocking and adopts only the frozen prefix while preserving appended events", async () => {
	const background = new BackgroundHistoryCompaction();
	let finish: (messages: ModelMessage[]) => void = () => {};
	const compact = vi.fn(
		() =>
			new Promise<ModelMessage[]>((resolve) => {
				finish = resolve;
			}),
	);
	background.start(old, compact);
	await Promise.resolve();
	const history = [...old, recent];
	const archive = vi.fn(async () => "archive:fixture");
	expect(await background.consume(history, archive, () => true)).toBe(history);
	expect(archive).not.toHaveBeenCalled();
	background.start(old, compact);
	expect(compact).toHaveBeenCalledTimes(1);
	finish(checkpoint);
	expect(await background.consume(history, archive, () => true, true)).toEqual([
		...checkpoint,
		recent,
	]);
	expect(archive).toHaveBeenCalledExactlyOnceWith(old);
	expect(background.running).toBe(false);
});

it("discards stale, over-budget, empty, and failed checkpoints without touching history", async () => {
	for (const variant of [
		"stale",
		"budget",
		"empty",
		"error",
		"archive",
	] as const) {
		const background = new BackgroundHistoryCompaction();
		background.start(old, async () => {
			if (variant === "error") throw new Error("provider failed");
			return variant === "empty" ? [] : checkpoint;
		});
		const history =
			variant === "stale"
				? [{ role: "user" as const, content: "changed" }, old[1], recent]
				: [...old, recent];
		const archive = vi.fn(async () => {
			if (variant === "archive") throw new Error("archive failed");
		});
		expect(
			await background.consume(
				history,
				archive,
				() => variant !== "budget",
				true,
			),
		).toBe(history);
		if (variant !== "archive") expect(archive).not.toHaveBeenCalled();
	}
});
