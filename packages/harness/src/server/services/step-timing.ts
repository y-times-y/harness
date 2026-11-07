import { AsyncLocalStorage } from "node:async_hooks";
import { isDevelopmentEnvironment } from "../../domain/development-environment";

/**
 * Development diagnostics (YTIMESY_DEBUG_STEP_TIMING=1, development only): one log line per
 * durable model step (and per chat send and its turn's wake on the web Worker)
 * with the wall time spent in each named phase. Spans may
 * overlap (parallel queries, provider calls inside a tool), so their sums are
 * attribution, not a partition of the step. Disabled, every helper is a pass-through.
 */
type Span = { count: number; ms: number; maxMs: number; firstAt: number };
type Trace = {
	startedAt: number;
	spans: Map<string, Span>;
	/** The first individual provider calls, in start order: [at, ms, label]. */
	calls: [number, number, string][];
	/** Spans started and not yet ended, by name. */
	open: Map<string, number>;
};

const traces = new AsyncLocalStorage<Trace>();

export function stepTimingEnabled() {
	return (
		process.env.YTIMESY_DEBUG_STEP_TIMING === "1" && isDevelopmentEnvironment()
	);
}

/** Where this isolate runs; the open harness makes no lookup for it. */
function isolateColo() {
	return Promise.resolve("unknown");
}

export async function withStepTrace<T>(
	meta: Record<string, string | number | boolean | null | undefined>,
	run: () => Promise<T>,
): Promise<T> {
	if (!stepTimingEnabled()) return run();
	const trace: Trace = {
		startedAt: Date.now(),
		spans: new Map(),
		calls: [],
		open: new Map(),
	};
	const line = (extra: Record<string, unknown>) =>
		JSON.stringify({
			...meta,
			...extra,
			startedAt: trace.startedAt,
			totalMs: Date.now() - trace.startedAt,
			spans: Object.fromEntries(
				[...trace.spans].map(([name, span]) => [
					name,
					[span.count, span.ms, span.maxMs, span.firstAt],
				]),
			),
			calls: trace.calls,
		});
	// A run still going after a while logs what it finished and what is
	// still in flight (calls with -1 ms), so a hang names its call.
	const slow = setTimeout(
		() =>
			console.log(
				"step-timing",
				line({ pending: Object.fromEntries(trace.open) }),
			),
		STEP_TRACE_SLOW_MS,
	);
	try {
		return await traces.run(trace, run);
	} finally {
		clearTimeout(slow);
		console.log("step-timing", line({ colo: await isolateColo() }));
		// The handoff's phases alone, so a long step's line is never too big to read.
		const handoff = [...trace.spans].filter(([name]) =>
			/^(commit|handoff|publish):|^turn:(commit|finalize|stopCommands|publication)/.test(
				name,
			),
		);
		if (handoff.length)
			console.log(
				"handoff-timing",
				JSON.stringify(
					Object.fromEntries(
						handoff.map(([name, span]) => [
							name,
							[trace.startedAt + span.firstAt, span.ms, span.count],
						]),
					),
				),
			);
	}
}

/** When a traced run is logged before it ends (withStepTrace). */
const STEP_TRACE_SLOW_MS = 15_000;

/** Records a duration measured elsewhere (a model call, a tool) in the current trace. */
export function recordStepTiming(name: string, ms: number, startedAt?: number) {
	const trace = traces.getStore();
	if (!trace) return;
	const span = trace.spans.get(name);
	const at = (startedAt ?? Date.now() - ms) - trace.startedAt;
	if (span) {
		span.count++;
		span.ms += ms;
		span.maxMs = Math.max(span.maxMs, ms);
	} else trace.spans.set(name, { count: 1, ms, maxMs: ms, firstAt: at });
}

export async function timed<T>(name: string, run: () => Promise<T>) {
	const trace = traces.getStore();
	if (!trace) return run();
	const startedAt = Date.now();
	trace.open.set(name, (trace.open.get(name) ?? 0) + 1);
	try {
		return await run();
	} finally {
		const left = (trace.open.get(name) ?? 1) - 1;
		if (left) trace.open.set(name, left);
		else trace.open.delete(name);
		recordStepTiming(name, Date.now() - startedAt, startedAt);
	}
}

/** Like timed, and also lists the call itself (first 80 per step) with a short label. */
export async function timedCall<T>(
	name: string,
	label: string,
	run: () => Promise<T>,
) {
	const trace = traces.getStore();
	const startedAt = Date.now();
	// Listed at its start (-1 ms while in flight), so a hang shows its call.
	const call: [number, number, string] | undefined =
		trace && trace.calls.length < 80
			? [
					startedAt - trace.startedAt,
					-1,
					label.replace(/\s+/g, " ").slice(0, 70),
				]
			: undefined;
	if (call) trace?.calls.push(call);
	try {
		return await timed(name, run);
	} finally {
		if (call) call[1] = Date.now() - startedAt;
	}
}

/** Times every request through a fetch, named by method and a coarse path shape. */
export function timedFetch(prefix: string, transport: typeof fetch) {
	return (async (request: RequestInfo | URL, init?: RequestInit) => {
		if (!traces.getStore()) return transport(request, init);
		const url = new URL(
			request instanceof Request ? request.url : String(request),
		);
		const method =
			init?.method ?? (request instanceof Request ? request.method : "GET");
		const shape = url.pathname
			.split("/")
			.filter(Boolean)
			.map((part) =>
				/^[0-9a-z]{16,}$/i.test(part) || /\d/.test(part) ? ":id" : part,
			)
			.join("/");
		let detail = "";
		try {
			const body = JSON.parse(String(init?.body ?? "{}"));
			detail = String(body.command ?? body.path ?? body.state ?? "");
		} catch {}
		return timedCall(
			`${prefix}:${method} ${shape}`,
			`${method} ${shape.split("/").pop()} ${detail}`,
			() => transport(request, init),
		);
	}) as typeof fetch;
}
