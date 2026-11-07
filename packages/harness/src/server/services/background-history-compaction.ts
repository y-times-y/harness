import { createHash } from "node:crypto";
import type { ModelMessage } from "ai";

const fingerprint = (messages: ModelMessage[]) =>
	createHash("sha256").update(JSON.stringify(messages)).digest("hex");

/** A speculative checkpoint may replace only its exact frozen prefix, never later events. */
export class BackgroundHistoryCompaction {
	private pending?: {
		count: number;
		fingerprint: string;
		original: ModelMessage[];
		promise: Promise<void>;
		settled: boolean;
		checkpoint: ModelMessage[] | null;
	};

	get running() {
		return Boolean(this.pending);
	}

	start(
		messages: ModelMessage[],
		compact: (frozen: ModelMessage[]) => Promise<ModelMessage[]>,
	) {
		if (this.pending) return;
		const original = structuredClone(messages);
		const pending = {
			count: original.length,
			fingerprint: fingerprint(original),
			original,
			settled: false,
			checkpoint: null as ModelMessage[] | null,
			promise: Promise.resolve(),
		};
		this.pending = pending;
		pending.promise = Promise.resolve()
			.then(() => compact(original))
			.then((checkpoint) => {
				pending.checkpoint = checkpoint;
			})
			.catch((error: unknown) => {
				// Keep the original on any speculative failure; the step's own
				// compaction runs when it is needed.
				console.warn("Background compaction failed; history kept.", {
					name: error instanceof Error ? error.name : "unknown",
				});
			})
			.finally(() => {
				pending.settled = true;
			});
	}

	async consume(
		messages: ModelMessage[],
		archive: (messages: ModelMessage[]) => Promise<unknown>,
		accept: (messages: ModelMessage[]) => boolean,
		wait = false,
	) {
		const pending = this.pending;
		if (!pending) return messages;
		if (wait) await pending.promise;
		if (!pending.settled) return messages;
		this.pending = undefined;
		if (
			!pending.checkpoint?.length ||
			messages.length < pending.count ||
			fingerprint(messages.slice(0, pending.count)) !== pending.fingerprint
		)
			return messages;
		const projected = [...pending.checkpoint, ...messages.slice(pending.count)];
		if (!accept(projected)) return messages;
		try {
			await archive(pending.original);
		} catch {
			return messages;
		}
		return projected;
	}

	async settle() {
		await this.pending?.promise;
	}
}
