import type {
	QuickJSContext,
	QuickJSHandle,
	QuickJSWASMModule,
} from "quickjs-emscripten-core";

/**
 * Model-written JavaScript runs inside QuickJS compiled to WebAssembly: a
 * separate interpreter with its own heap, never the host engine (no eval, new
 * Function or node:vm). The guest gets no fetch, require, process, timers,
 * filesystem or environment; its only capability is the injected `tools`
 * object, whose calls the host routes through the ordinary tool executors.
 * The same WASM runs on Workers and Node. It loads on first use, so it costs
 * nothing at Worker startup.
 */

export type CodeModeLimits = {
	/**
	 * Guest execution budget in QuickJS interrupt polls, the only bound that
	 * holds on Workers, where the clock does not advance during CPU work. One
	 * poll is about 10k loop iterations or calls: 2,500 polls measured ~0.1 s for
	 * an empty loop and ~10 s for a JSON.stringify loop on an M-series Mac.
	 */
	readonly interruptTicks: number;
	/** Guest execution budget by wall clock, enforced where the clock advances (Node). */
	readonly cpuMs: number;
	/** QuickJS's own allocation limit; approximate in this build (see CODE_MODE_WASM_MEMORY_BYTES). */
	readonly memoryBytes: number;
	readonly stackBytes: number;
	readonly resultBytes: number;
	readonly consoleBytes: number;
	readonly toolResultBytes: number;
	readonly maxToolCalls: number;
	readonly maxConcurrentToolCalls: number;
};

export const DEFAULT_CODE_MODE_LIMITS: CodeModeLimits = {
	interruptTicks: 2_500,
	cpuMs: 2_000,
	memoryBytes: 32 * 1024 * 1024,
	stackBytes: 512 * 1024,
	resultBytes: 24_000,
	consoleBytes: 8_000,
	toolResultBytes: 2 * 1024 * 1024,
	maxToolCalls: 40,
	maxConcurrentToolCalls: 6,
};

export type SandboxToolCall = (
	name: string,
	args: unknown,
	index: number,
) => Promise<unknown>;

export type SandboxOutcome = {
	readonly ok: boolean;
	/** JSON text of the program's return value, possibly truncated. */
	readonly result?: string;
	readonly resultTruncated?: boolean;
	readonly error?: string;
	readonly console: string;
	readonly consoleTruncated?: boolean;
	readonly toolCalls: number;
};

type WasmModuleLoader = () => Promise<WebAssembly.Module>;
let wasmModuleLoader: WasmModuleLoader | undefined;
let quickjs: Promise<QuickJSWASMModule> | undefined;

/**
 * Workers cannot compile WebAssembly from bytes at runtime; the edge entry
 * supplies the module precompiled by the host build. Node loads the file itself.
 */
export function provideCodeModeWasmModule(loader: WasmModuleLoader) {
	wasmModuleLoader = loader;
	quickjs = undefined;
}

/**
 * The hard memory bound. This QuickJS build cannot measure allocation sizes
 * (no malloc_usable_size), so its per-runtime limit counts blocks, not bytes;
 * a capped WebAssembly memory makes malloc fail instead of growing the heap
 * to the default 2 GB, which would exceed a Worker isolate's 128 MB. One
 * memory serves every program in the isolate; freed memory is reused.
 */
const WASM_PAGE_BYTES = 64 * 1024;
export const CODE_MODE_WASM_MEMORY_BYTES = 48 * 1024 * 1024;

function loadQuickJS() {
	quickjs ??= (async () => {
		const [core, base] = await Promise.all([
			import("quickjs-emscripten-core"),
			import("@jitl/quickjs-wasmfile-release-sync"),
		]);
		const variant = core.newVariant(base.default, {
			wasmMemory: async () =>
				new WebAssembly.Memory({
					// Emscripten's build requires 16 MB to start.
					initial: (16 * 1024 * 1024) / WASM_PAGE_BYTES,
					maximum: CODE_MODE_WASM_MEMORY_BYTES / WASM_PAGE_BYTES,
				}),
			...(wasmModuleLoader ? { wasmModule: wasmModuleLoader } : {}),
		});
		return core.newQuickJSWASMModuleFromVariant(variant);
	})().catch((error) => {
		quickjs = undefined;
		throw error;
	});
	return quickjs;
}

/** Tool names the guest sees as tools[name]; MCP names may contain dashes. */
const TOOL_NAME = /^[A-Za-z_$][A-Za-z0-9_$-]{0,63}$/;

/** A tool a program can look up with searchTools(query) (code mode primary). */
export type CodeModeCatalogEntry = {
	readonly name: string;
	/** Its TypeScript-like declaration, as searchTools returns it. */
	readonly declaration: string;
};

/**
 * searchTools(query): the declarations of the catalog's tools whose name or
 * declaration contains a word of the query (every tool for an empty query
 * or no match, with a note); ALL_TOOLS: every declaration. Both run in the
 * guest, so a lookup is no tool call.
 */
function discoveryPrelude(catalog: readonly CodeModeCatalogEntry[]) {
	if (!catalog.length) return "";
	return `
	const catalog = ${JSON.stringify(catalog.map((entry) => ({ name: entry.name, declaration: entry.declaration, text: `${entry.name} ${entry.declaration}`.toLowerCase() })))};
	globalThis.ALL_TOOLS = Object.freeze(catalog.map((entry) => entry.declaration));
	globalThis.searchTools = (query) => {
		const words = String(query ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? [];
		const hits = catalog.filter((entry) => words.some((word) => entry.text.includes(word)));
		return hits.length
			? hits.map((entry) => entry.declaration).join("\\n\\n")
			: (words.length ? "// No tool matched; every tool:\\n" : "") + catalog.map((entry) => entry.declaration).join("\\n\\n");
	};`;
}

function prelude(
	names: readonly string[],
	catalog: readonly CodeModeCatalogEntry[] = [],
) {
	return `"use strict";
(() => {${discoveryPrelude(catalog)}
	const call = globalThis.__ytimesyCall;
	const write = globalThis.__ytimesyLog;
	delete globalThis.__ytimesyCall;
	delete globalThis.__ytimesyLog;
	// A failed call resolves to a failure value instead of rejecting, so one
	// missing file or refused edit never sinks a Promise.all and the other
	// results still come back.
	const failed = (name, error) => {
		const message = error && typeof error.message === "string" ? error.message : String(error);
		return Object.freeze({ ok: false, tool: name, error: message, toString: () => "[" + name + " failed] " + message });
	};
	const tools = {};
	for (const name of ${JSON.stringify(names)}) {
		tools[name] = (args) =>
			call(name, JSON.stringify(args === undefined ? {} : args)).then(
				(text) => JSON.parse(text),
				(error) => failed(name, error),
			);
	}
	const show = (value) => {
		if (typeof value === "string") return value;
		try { const text = JSON.stringify(value); return text === undefined ? String(value) : text; }
		catch { return String(value); }
	};
	const log = (level) => (...values) => write(level, values.map(show).join(" "));
	globalThis.tools = Object.freeze(tools);
	globalThis.console = Object.freeze({ log: log("log"), info: log("info"), warn: log("warn"), error: log("error"), debug: log("debug") });
	// text(...) adds to what comes back as the program goes, kept even if it later throws.
	globalThis.text = log("log");
	globalThis.print = globalThis.text;
})();`;
}

function program(code: string) {
	return `(async () => {
	const value = await (async () => {
${code}
	})();
	return value === undefined ? undefined : JSON.stringify(value);
})()`;
}

function errorText(vm: QuickJSContext, handle: QuickJSHandle) {
	const dumped = vm.dump(handle) as unknown;
	if (dumped && typeof dumped === "object") {
		const { name, message, stack } = dumped as Record<string, unknown>;
		const head = [name, message].filter(Boolean).join(": ");
		const location =
			typeof stack === "string" ? stack.split("\n").slice(0, 4).join("\n") : "";
		return location ? `${head}\n${location}` : head || "Program failed.";
	}
	return String(dumped);
}

function clipped(text: string, limit: number) {
	return text.length > limit
		? { text: text.slice(0, limit), truncated: true }
		: { text, truncated: false };
}

/** Runs one program to completion in a fresh QuickJS runtime that is disposed afterwards. */
export async function runSandboxedProgram(input: {
	code: string;
	tools: readonly string[];
	call: SandboxToolCall;
	signal: AbortSignal;
	limits?: Partial<CodeModeLimits>;
	/** Tools searchTools / ALL_TOOLS describe (code mode primary). */
	catalog?: readonly CodeModeCatalogEntry[];
}): Promise<SandboxOutcome> {
	const limits = { ...DEFAULT_CODE_MODE_LIMITS, ...input.limits };
	const names = input.tools.filter((name) => TOOL_NAME.test(name));
	input.signal.throwIfAborted();
	const module = await loadQuickJS();
	const runtime = module.newRuntime();
	runtime.setMemoryLimit(limits.memoryBytes);
	runtime.setMaxStackSize(limits.stackBytes);
	let ticks = 0;
	let guestMs = 0;
	let enteredAt = 0;
	let budgetExceeded = false;
	runtime.setInterruptHandler(() => {
		ticks++;
		const exceeded =
			ticks > limits.interruptTicks ||
			guestMs + (performance.now() - enteredAt) > limits.cpuMs;
		if (exceeded) budgetExceeded = true;
		return exceeded || input.signal.aborted;
	});
	const vm = runtime.newContext();
	let consoleText = "";
	let consoleTruncated = false;
	let calls = 0;
	let active = 0;
	const queue: Array<() => void> = [];
	const inflight = new Set<Promise<unknown>>();
	let disposed = false;
	let closing = false;
	const unsettled = new Set<{ dispose(): void }>();
	let hostFailure: string | undefined;
	let wake: () => void = () => {};

	const guest = <T>(run: () => T): T => {
		enteredAt = performance.now();
		try {
			return run();
		} finally {
			guestMs += performance.now() - enteredAt;
		}
	};
	const pump = () => {
		if (disposed) return;
		const result = guest(() => runtime.executePendingJobs());
		if (result.error) {
			hostFailure ??= errorText(vm, result.error);
			result.error.dispose();
		}
		wake();
	};

	const log = vm.newFunction("log", (levelHandle, textHandle) => {
		if (consoleTruncated) return;
		const level = vm.getString(levelHandle);
		const line = `${level === "log" ? "" : `[${level}] `}${vm.getString(textHandle)}\n`;
		const room = limits.consoleBytes - consoleText.length;
		if (line.length > room) {
			consoleText += line.slice(0, Math.max(0, room));
			consoleTruncated = true;
		} else consoleText += line;
	});
	vm.setProp(vm.global, "__ytimesyLog", log);
	log.dispose();

	const call = vm.newFunction("call", (nameHandle, argsHandle) => {
		const name = vm.getString(nameHandle);
		const argsText = vm.getString(argsHandle);
		const deferred = vm.newPromise();
		unsettled.add(deferred);
		const index = calls++;
		const settle = (ok: boolean, text: string) => {
			if (disposed) return;
			unsettled.delete(deferred);
			if (ok) {
				const value = vm.newString(text);
				deferred.resolve(value);
				value.dispose();
			} else {
				const error = vm.newError({ name: "ToolError", message: text });
				deferred.reject(error);
				error.dispose();
			}
			deferred.dispose();
			pump();
		};
		const refusal = closing
			? "The program already returned; tool calls after that are not run."
			: index >= limits.maxToolCalls
				? `Tool call limit reached (${limits.maxToolCalls} per program); return what you have and continue in another call.`
				: undefined;
		if (refusal) {
			queueMicrotask(() => settle(false, refusal));
			return deferred.handle;
		}
		const started = new Promise<void>((resolve) => {
			if (active < limits.maxConcurrentToolCalls) {
				active++;
				resolve();
			} else
				queue.push(() => {
					active++;
					resolve();
				});
		});
		const work = started
			.then(() => input.call(name, JSON.parse(argsText), index))
			.then(
				(value) => {
					const text = JSON.stringify(value ?? null) ?? "null";
					if (text.length > limits.toolResultBytes)
						throw new Error(
							`Tool result exceeds ${limits.toolResultBytes} bytes; narrow the request.`,
						);
					settle(true, text);
				},
				(error: unknown) =>
					settle(
						false,
						error instanceof Error ? error.message : "Tool call failed.",
					),
			)
			.catch((error: unknown) =>
				settle(
					false,
					error instanceof Error ? error.message : "Tool call failed.",
				),
			)
			.finally(() => {
				active--;
				queue.shift()?.();
				inflight.delete(work);
				wake();
			});
		inflight.add(work);
		return deferred.handle;
	});
	vm.setProp(vm.global, "__ytimesyCall", call);
	call.dispose();

	const finish = async (
		outcome: Omit<SandboxOutcome, "console" | "toolCalls">,
	) => {
		// Side effects already started finish (and journal) before the result returns.
		closing = true;
		await Promise.allSettled([...inflight]);
		disposed = true;
		return {
			...outcome,
			console: consoleText,
			...(consoleTruncated ? { consoleTruncated: true } : {}),
			toolCalls: Math.min(calls, limits.maxToolCalls),
		};
	};

	try {
		const setup = guest(() =>
			vm.evalCode(prelude(names, input.catalog), "prelude.js"),
		);
		if (setup.error) {
			const message = errorText(vm, setup.error);
			setup.error.dispose();
			throw new Error(`Sandbox setup failed: ${message}`);
		}
		setup.value.dispose();
		const evaluated = guest(() =>
			vm.evalCode(program(input.code), "program.js"),
		);
		if (evaluated.error) {
			const message = budgetExceeded
				? "Program exceeded its CPU budget."
				: errorText(vm, evaluated.error);
			evaluated.error.dispose();
			return await finish({ ok: false, error: message });
		}
		const promise = evaluated.value;
		try {
			pump();
			while (true) {
				if (input.signal.aborted) {
					await Promise.allSettled([...inflight]);
					input.signal.throwIfAborted();
				}
				if (budgetExceeded)
					return await finish({
						ok: false,
						error: "Program exceeded its CPU budget.",
					});
				if (hostFailure) return await finish({ ok: false, error: hostFailure });
				const state = vm.getPromiseState(promise);
				if (state.type === "fulfilled") {
					const value = state.value;
					const text =
						vm.typeof(value) === "string" ? vm.getString(value) : undefined;
					value.dispose();
					if (text === undefined) return await finish({ ok: true });
					const result = clipped(text, limits.resultBytes);
					return await finish({
						ok: true,
						result: result.text,
						...(result.truncated ? { resultTruncated: true } : {}),
					});
				}
				if (state.type === "rejected") {
					const message = budgetExceeded
						? "Program exceeded its CPU budget."
						: errorText(vm, state.error);
					state.error.dispose();
					return await finish({ ok: false, error: message });
				}
				if (!inflight.size)
					return await finish({
						ok: false,
						error:
							"Program is awaiting something that can never settle (no tool call is running). Await only tools.* calls.",
					});
				await new Promise<void>((resolve) => {
					const abort = () => wake();
					wake = () => {
						input.signal.removeEventListener("abort", abort);
						wake = () => {};
						resolve();
					};
					input.signal.addEventListener("abort", abort, { once: true });
				});
			}
		} finally {
			promise.dispose();
		}
	} finally {
		disposed = true;
		for (const deferred of unsettled) deferred.dispose();
		vm.dispose();
		runtime.dispose();
	}
}
