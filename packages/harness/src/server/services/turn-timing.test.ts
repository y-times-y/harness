import { expect, it } from "vitest";
import {
	markTurnPhase,
	timedModelFetch,
	turnTiming,
	turnTimingLine,
	withTurnTimingMarks,
} from "./turn-timing";

it("formats one line of ids, numbers and fixed codes", () => {
	expect(
		JSON.parse(
			turnTimingLine({
				turnId: "turn-1",
				step: 1,
				startedAt: 10_500,
				queuedAt: 10_000,
				early: false,
				earlyReason: "hook-config-unknown",
				outcome: "completed",
				phases: { leaseAcquired: 12, firstToken: 2100 },
			}),
		),
	).toEqual({
		ytimesy: "turn-timing",
		turn: "turn-1",
		step: 1,
		queuedMs: 500,
		early: false,
		earlyReason: "hook-config-unknown",
		outcome: "completed",
		phases: { leaseAcquired: 12, firstToken: 2100 },
	});
});

it("leaves out what it does not know", () => {
	expect(
		JSON.parse(
			turnTimingLine({ turnId: "t", step: 2, startedAt: 1, phases: {} }),
		),
	).toEqual({ ytimesy: "turn-timing", turn: "t", step: 2, phases: {} });
});

it("keeps each phase's first mark and the first early decision, and writes once", () => {
	let clock = 1_000;
	const lines: string[] = [];
	const timing = turnTiming({
		turnId: "t",
		step: 1,
		startedAt: 1_000,
		now: () => clock,
	});
	clock = 1_040.4;
	timing.mark("leaseAcquired");
	clock = 1_090;
	timing.mark("leaseAcquired");
	timing.early(true, "early");
	timing.early(false, "workspace-ready");
	clock = 1_300;
	timing.write("completed", (line) => lines.push(line));
	timing.write("failed", (line) => lines.push(line));
	expect(lines).toHaveLength(1);
	expect(JSON.parse(lines[0])).toMatchObject({
		early: true,
		earlyReason: "early",
		outcome: "completed",
		phases: { leaseAcquired: 40, end: 300 },
	});
});

it("marks a step's model request start, response headers and first body byte, in order", async () => {
	const marks: string[] = [];
	let release: (() => void) | undefined;
	const upstream: typeof fetch = async () => {
		marks.push("upstream-called");
		const body = new ReadableStream<Uint8Array>({
			async start(controller) {
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
				controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
				controller.close();
			},
		});
		return new Response(body, {
			status: 200,
			headers: { "content-type": "text/event-stream", "x-request-id": "r1" },
		});
	};
	const timed = timedModelFetch(upstream);
	const response = await withTurnTimingMarks(
		(phase) => marks.push(phase),
		() => timed("https://model.test/v1/responses", { method: "POST" }),
	);
	expect(marks).toEqual([
		"modelFetchStarted",
		"upstream-called",
		"modelHeaders",
	]);
	expect(response.status).toBe(200);
	expect(response.headers.get("x-request-id")).toBe("r1");
	release?.();
	expect(await response.text()).toBe("data: {}\n\ndata: [DONE]\n\n");
	expect(marks).toEqual([
		"modelFetchStarted",
		"upstream-called",
		"modelHeaders",
		"modelFirstByte",
	]);
});

it("passes a model request through untouched outside a durable step", async () => {
	const original = new Response("ok");
	const timed = timedModelFetch(async () => original);
	expect(await timed("https://model.test/")).toBe(original);
	// Marking outside a step is a no-op.
	expect(() => markTurnPhase("egress:vpc")).not.toThrow();
});

it("feeds marks from code under a step into that step's line only", async () => {
	let clock = 0;
	const lines: string[] = [];
	const timing = turnTiming({
		turnId: "t",
		step: 1,
		startedAt: 0,
		now: () => clock,
	});
	await withTurnTimingMarks(
		(phase) => timing.mark(phase),
		async () => {
			clock = 900;
			markTurnPhase("egress:vpc");
		},
	);
	markTurnPhase("egress:relay-1");
	timing.write("completed", (line) => lines.push(line));
	expect(JSON.parse(lines[0]).phases).toEqual({ "egress:vpc": 900, end: 900 });
});
