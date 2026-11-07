import { asSchema, type Tool, type ToolSet, tool } from "ai";
import { z } from "zod";
import {
	CODE_MODE_TOOL,
	type CodeModeCallLog,
	type CodeModeResult,
} from "../../domain/code-mode";
import {
	LEAN_COMMAND_ARGUMENTS,
	leanToolNames,
	leanToolRole,
} from "../../domain/harness-model-profile";
import { reportedToolFailure } from "../../domain/harness-performance";
import {
	CALL_MCP_TOOL_TOOL,
	SEARCH_MCP_TOOLS_TOOL,
} from "../../domain/mcp-tool-call";
import { AGENT_SEND_TOOL, AGENT_TOOL } from "../../domain/subagent";
import { publicToolDetail } from "../../domain/tool-detail";
import { toolDeclaration } from "./code-mode-declarations";
import {
	type CodeModeCatalogEntry,
	type CodeModeLimits,
	runSandboxedProgram,
} from "./code-mode-sandbox";
import { LEAN_COMMAND_MAX_SECONDS } from "./lean-engine";
import { keepHead, LEAN_MAX_BYTES, LEAN_MAX_LINES } from "./lean-output";
import { toolRequestFingerprint } from "./tool-execution-identity";

export { CODE_MODE_TOOL } from "../../domain/code-mode";

type ExecuteOptions = Parameters<NonNullable<Tool["execute"]>>[1];

/** Characters of each inner call's input and output in the model's call log. */
const LOG_PREVIEW_CHARACTERS = 160;
/** Characters of each inner call's input and output kept in the result record. */
const RECORD_CHARACTERS = 2_000;
const MAX_TOOL_CALLS = 40;

/**
 * How a failed inner call reaches the program (code-mode-sandbox.ts): a
 * value, not a rejection, so one failure never sinks a Promise.all.
 */
const FAILURE_VALUE =
	"A failed call does not throw: it resolves to { ok: false, error }, so one failure never sinks a Promise.all; check r.ok === false before using a result.";

/**
 * The tools a program may call: the lean surface's own tools (every shape's
 * names), the user's MCP tools and the subagent tools (subagents=on; also
 * in the tool list, so the model may call them either way), never
 * provider-hosted tools (web search runs inside the model call, so a program
 * cannot call it), plan, secret or turn-ending tools. `extra` names other
 * tools the caller allows (a host's own, such as the requirements
 * ledger or the goal tool).
 */
function callableTools(
	tools: ToolSet,
	deferred: ReadonlySet<string>,
	extra: ReadonlySet<string>,
) {
	const lean = new Set<string>(leanToolNames());
	return Object.fromEntries(
		Object.entries(tools).filter(
			([name, definition]) =>
				name !== CODE_MODE_TOOL &&
				definition.execute &&
				definition.type !== "provider" &&
				(lean.has(name) ||
					deferred.has(name) ||
					extra.has(name) ||
					name === AGENT_TOOL ||
					name === AGENT_SEND_TOOL ||
					name === SEARCH_MCP_TOOLS_TOOL ||
					name === CALL_MCP_TOOL_TOOL ||
					name.startsWith("mcp__")),
		),
	);
}

const codeInput = z.object({
	code: z
		.string()
		.min(1)
		.max(20_000)
		.describe("The body of an async JavaScript function"),
	timeout: z
		.number()
		.int()
		.min(1)
		.max(LEAN_COMMAND_MAX_SECONDS)
		.optional()
		.describe(
			`Seconds before the program is stopped (default and at most ${LEAN_COMMAND_MAX_SECONDS})`,
		),
});

class InnerToolError extends Error {}

const clip = (text: string, limit: number) =>
	text.length > limit
		? `${text.slice(0, limit)}… [${text.length - limit} more characters]`
		: text;

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** Turns a tool's model output (toModelOutput) into the value a program receives. */
function modelOutputValue(output: unknown, imageTool: string): unknown {
	const part = output as { type?: string; value?: unknown } | null;
	switch (part?.type) {
		case "text":
			return part.value;
		case "json":
			return part.value;
		case "error-text":
		case "error-json":
			throw new InnerToolError(
				typeof part.value === "string"
					? part.value
					: JSON.stringify(part.value),
			);
		case "content":
			return (Array.isArray(part.value) ? part.value : [])
				.map((entry: { type?: string; text?: string }) =>
					entry.type === "text"
						? (entry.text ?? "")
						: `[Image omitted: programs receive text only; view it with ${imageTool} directly.]`,
				)
				.join("\n");
		default:
			return output;
	}
}

/**
 * What a program receives from an inner call: exactly the text (or JSON) the
 * model would see from the same direct call, so limits and truncation notes
 * are the lean surface's own. A command also reports its exit code, because
 * a non-zero exit is not an error for a direct call either.
 */
async function programValue(
	name: string,
	definition: Tool,
	args: unknown,
	result: unknown,
	toolCallId: string,
) {
	const shown = definition.toModelOutput
		? modelOutputValue(
				await definition.toModelOutput({
					toolCallId,
					input: args as never,
					output: result as never,
				}),
				name,
			)
		: result;
	if (leanToolRole(name) !== "command") return shown;
	const status = (result as { status?: unknown; id?: unknown } | null)?.status;
	return {
		output: shown,
		exitCode: typeof status === "number" ? status : null,
		...(status === "running"
			? { running: true, id: (result as { id?: unknown }).id }
			: {}),
	};
}

const asText = (value: unknown) =>
	typeof value === "string" ? value : (JSON.stringify(value) ?? "null");

/** The program's return value as the model sees it, within the lean output limit. */
function shownReturnValue(json: string | undefined) {
	if (json === undefined) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		// The sandbox cut the JSON at its byte cap.
		value = json;
	}
	const text =
		typeof value === "string" ? value : JSON.stringify(value, null, 2);
	const kept = keepHead(text, {
		maxBytes: LEAN_MAX_BYTES,
		maxLines: LEAN_MAX_LINES,
	});
	return kept.truncated
		? `${kept.content}\n[Return value cut to lines ${kept.firstLine}-${kept.lastLine} of ${kept.totalLines}; return less: filter or summarize in code.]`
		: kept.content;
}

/** The model's view of a run: the return value, console, then one line per inner call. */
export function codeModeModelText(result: CodeModeResult) {
	const lines: string[] = [];
	if (result.error) lines.push(`Program failed: ${result.error}`);
	else lines.push(result.result ?? "(no return value)");
	if (result.console) lines.push(`Console:\n${result.console.trimEnd()}`);
	if (result.calls.length)
		lines.push(
			[
				`Tool calls (${result.calls.length}):`,
				...result.calls.map(
					(call, index) =>
						`${index + 1}. ${call.tool} ${clip(oneLine(call.input), LOG_PREVIEW_CHARACTERS)} → ${call.status} (${call.ms} ms)${call.output ? `: ${clip(oneLine(call.output), LOG_PREVIEW_CHARACTERS)}` : ""}`,
				),
			].join("\n"),
		);
	return lines.join("\n\n");
}

export type CodeModeJournal = {
	/** The recorded result of this run_code call, if one completed before. */
	recorded: () => Promise<CodeModeResult | undefined>;
	record: (result: CodeModeResult) => Promise<void>;
};

/** A run's record kept in memory: nothing survives the process (local and unattended runs). */
export function memoryCodeModeJournal(): (
	toolCallId: string,
) => CodeModeJournal {
	const results = new Map<string, CodeModeResult>();
	return (toolCallId) => ({
		recorded: async () => results.get(toolCallId),
		record: async (result) => {
			results.set(toolCallId, result);
		},
	});
}

/**
 * run_code (harness variant codeMode=on): one inference, several tool calls.
 * The program runs server-side in QuickJS (code-mode-sandbox.ts) and calls
 * the SAME tool executors the model could call directly: `tools` is the
 * turn's final tool set, already wrapped with lifecycle hooks, secret
 * redaction, and each inner call gets its own derived call id
 * (`<id>:code:<n>`), so the per-call journal, background tracking ids and
 * cancellation behave as for a direct call.
 */
export function codeModeTool(input: {
	tools: ToolSet;
	signal: AbortSignal;
	/** The record of a run, keyed by tool call: durable in the cloud product, memoryCodeModeJournal() elsewhere. */
	journal: (toolCallId: string, fingerprint: string) => CodeModeJournal;
	sessionId: string;
	turnId: string;
	toolCallPrefix?: string;
	limits?: Partial<CodeModeLimits>;
	/**
	 * primary (harness variant codeMode=primary): run_code is the main way to
	 * work; its description teaches batching, and `deferred` tools (a large
	 * MCP setup's search and call tools) are callable only from programs,
	 * found with searchTools(query).
	 */
	mode?: "on" | "primary";
	/** Tools not in the request's tool list that programs may call (primary). */
	deferred?: readonly string[];
	/** Other tools in `tools` that programs may call too (a host's own). */
	callable?: readonly string[];
}): Tool | undefined {
	const deferred = new Set(
		input.mode === "primary" ? (input.deferred ?? []) : [],
	);
	const callable = callableTools(
		input.tools,
		deferred,
		new Set(input.callable ?? []),
	);
	const names = Object.keys(callable);
	if (!names.length) return undefined;
	const hidden = names.filter((name) => deferred.has(name));
	let catalog: Promise<CodeModeCatalogEntry[]> | undefined;
	const loadCatalog = () => {
		catalog ??= Promise.all(
			hidden.map(async (name) => ({
				name,
				declaration: await toolDeclaration(name, callable[name] as Tool),
			})),
		);
		return catalog;
	};
	const journal = input.journal;
	const command = names.find((name) => leanToolRole(name) === "command");
	const read = names.find((name) => leanToolRole(name) === "read");
	const example =
		command && read
			? ` Example: const [a, b, t] = await Promise.all([tools.${read}({ path: "src/a.ts" }), tools.${read}({ path: "src/b.ts" }), tools.${command}({ command: "npm test 2>&1 | tail -20" })]); return { a: a.split("\\n").length, b: b.includes("export"), tests: t.exitCode };`
			: "";
	const description =
		input.mode === "primary"
			? primaryDescription(
					names.filter((name) => !deferred.has(name)),
					hidden.length > 0,
				)
			: undefined;
	return tool({
		description:
			description ??
			`Run a JavaScript program (the body of an async function) that calls your tools, to do several steps in one call. Available: ${names.map((name) => `tools.${name}(args)`).join(", ")}; each takes the same arguments as the tool and resolves to the text it would show you (${command ? `tools.${command} resolves to { output, exitCode }` : "MCP tools to their result"}). ${FAILURE_VALUE} Use Promise.all for independent calls. Only the return value (JSON-serializable, same size limit as a file read) and text(...) output come back, with one line per tool call, so filter large outputs in code. No network, imports, timers or environment; at most ${MAX_TOOL_CALLS} tool calls per program.${example}`,
		inputSchema: codeInput,
		execute: async (raw, options) => {
			const args = codeInput.parse(raw);
			const fingerprint = toolRequestFingerprint(CODE_MODE_TOOL, args);
			const record = journal(options.toolCallId, fingerprint);
			const replayed = await record.recorded();
			if (replayed) return replayed;
			const timeout = new AbortController();
			const timer = setTimeout(
				() => timeout.abort(new Error("timeout")),
				(args.timeout ?? LEAN_COMMAND_MAX_SECONDS) * 1000,
			);
			const signal = AbortSignal.any([
				input.signal,
				...(options.abortSignal ? [options.abortSignal] : []),
				timeout.signal,
			]);
			const calls: CodeModeCallLog[] = [];
			let firstStarted: number | undefined;
			const call = async (name: string, callArgs: unknown, index: number) => {
				const definition = callable[name];
				const started = performance.now();
				firstStarted ??= started;
				const at = Math.round(started - firstStarted);
				const log = (
					status: CodeModeCallLog["status"],
					output: unknown,
				): void => {
					calls[index] = {
						tool: name,
						input: clip(asText(callArgs ?? {}), RECORD_CHARACTERS),
						status,
						ms: Math.round(performance.now() - started),
						at,
						output: clip(asText(output), RECORD_CHARACTERS),
					};
				};
				const toolCallId = `${options.toolCallId}:code:${index}`;
				try {
					const validate = asSchema(definition.inputSchema).validate;
					const parsed = validate ? await validate(callArgs) : undefined;
					if (parsed && !parsed.success)
						throw new InnerToolError(
							`Invalid arguments for ${name}: ${parsed.error.message}`,
						);
					signal.throwIfAborted();
					const value = parsed?.success ? parsed.value : callArgs;
					const result = await (
						definition.execute as NonNullable<Tool["execute"]>
					)(value, {
						toolCallId,
						messages: options.messages,
						abortSignal: signal,
						context: options.context,
					} as ExecuteOptions);
					if (
						result &&
						typeof result === "object" &&
						Symbol.asyncIterator in result
					)
						throw new InnerToolError(`${name} streams; call it directly.`);
					// PreToolUse hooks refuse with { blocked, error }.
					const blocked = result as { blocked?: unknown; error?: unknown };
					if (blocked && blocked.blocked === true) {
						const message =
							typeof blocked.error === "string"
								? blocked.error
								: `${name} was refused.`;
						log("refused", message);
						throw new InnerToolError(message);
					}
					const shown = await programValue(
						name,
						definition,
						value,
						result,
						toolCallId,
					);
					log(reportedToolFailure(result) ? "failed" : "completed", shown);
					return shown;
				} catch (error) {
					signal.throwIfAborted();
					const message = publicToolDetail(
						error instanceof Error ? error.message : "Tool call failed.",
					);
					if (!calls[index]) log("failed", message);
					throw new Error(message);
				}
			};
			let outcome: Awaited<ReturnType<typeof runSandboxedProgram>>;
			try {
				outcome = await runSandboxedProgram({
					code: args.code,
					tools: names,
					signal,
					...(hidden.length ? { catalog: await loadCatalog() } : {}),
					limits: {
						maxToolCalls: MAX_TOOL_CALLS,
						resultBytes: 4 * LEAN_MAX_BYTES,
						...input.limits,
					},
					call,
				});
			} catch (error) {
				// The turn was cancelled: like any tool, the call ends with the turn.
				if (!timeout.signal.aborted || input.signal.aborted) throw error;
				outcome = {
					ok: false,
					error: `Program stopped at its ${args.timeout ?? LEAN_COMMAND_MAX_SECONDS} s time limit; calls already started finished first.`,
					console: "",
					toolCalls: calls.length,
				};
			} finally {
				clearTimeout(timer);
			}
			const result: CodeModeResult = storedResult({
				ok: outcome.ok,
				...(outcome.ok
					? { result: shownReturnValue(outcome.result) }
					: { error: outcome.error ?? "Program failed." }),
				...(outcome.console
					? {
							console: `${outcome.console}${outcome.consoleTruncated ? "\n[Console output cut; log less.]" : ""}`,
						}
					: {}),
				calls: calls.filter(Boolean),
			});
			await record.record(result);
			return result;
		},
		toModelOutput: ({ output }) => ({
			type: "text",
			value: codeModeModelText(output as CodeModeResult),
		}),
	});
}

/** Drops an undefined return value so the record has no empty keys. */
function storedResult(result: CodeModeResult): CodeModeResult {
	return result.result === undefined && result.ok
		? {
				ok: true,
				...(result.console ? { console: result.console } : {}),
				calls: result.calls,
			}
		: result;
}

/** Read and command argument names per lean shape, for the description's examples. */
function exampleKeys(names: readonly string[]) {
	const command = names.find((name) => leanToolRole(name) === "command");
	const read = names.find((name) => leanToolRole(name) === "read");
	const edit = names.find((name) => leanToolRole(name) === "edit");
	return {
		command,
		commandKey: (command && LEAN_COMMAND_ARGUMENTS[command]) ?? "command",
		read,
		readKey: read === "read" ? "path" : "file_path",
		edit,
	};
}

/**
 * run_code's description in code mode primary: the batching patterns as
 * short examples in the surface's own tool names. It depends only on the
 * turn's tool names, so it is byte-stable across steps.
 */
function primaryDescription(direct: readonly string[], hasDeferred: boolean) {
	const { command, commandKey, read, readKey, edit } = exampleKeys(direct);
	const readCall = (path: string) =>
		read
			? `tools.${read}({ ${readKey}: "${path}" })`
			: `tools.${command}({ ${commandKey}: "cat ${path}" })`;
	const run = (text: string) =>
		`tools.${command}({ ${commandKey}: "${text}" })`;
	const examples = command
		? [
				`- Parallel reads and searches: const [a, b, hits] = await Promise.all([${readCall("src/a.ts")}, ${readCall("src/b.ts")}, ${run("rg -n parseHeader src")}]); return { a, b, hits };`,
				`- Edit then test: const e = await ${edit === "edit" && readKey === "path" ? `tools.edit({ path: "src/a.ts", edits: [{ old_string: "i < n", new_string: "i <= n" }] })` : `tools.${edit ?? command}(…)`}; if (e.ok === false) return e.error; const t = await ${run("npm test 2>&1 | tail -40")}; return t.exitCode === 0 ? "pass" : t.output;`,
				`- Report as you go: text("build:", b.exitCode) adds a line to what comes back, even if a later step throws.`,
				`- Return only what you need: filter, slice or count long output in code (e.g. the failing test names), not the whole log.`,
			]
		: [];
	return [
		`Run a JavaScript program (the body of an async function) that calls your tools and returns only what you need, in one step. Prefer it whenever you would make two or more calls whose inputs you already know.`,
		`tools.<name>(args) takes the tool's own arguments and resolves to the text it would show you${command ? ` (tools.${command} to { output, exitCode })` : ""}. ${FAILURE_VALUE} Direct tools: ${direct.map((name) => `tools.${name}`).join(", ")}.${hasDeferred ? " Other tools (not in your tool list) are callable here too: searchTools(query) returns their TypeScript declarations and ALL_TOOLS lists them all; call them as tools.<name>(args)." : ""}`,
		...examples,
		`The return value (JSON-serializable, same size limit as a file read) and text(...) output (printed as the program goes, kept if it later throws) come back with one line per tool call. No network, imports, timers or environment; at most ${MAX_TOOL_CALLS} tool calls per program.`,
	].join("\n");
}

/** The command tool's line in code mode primary: what it is still for. */
export const PRIMARY_COMMAND_NOTE =
	"Use it for one command, or a long-running or interactive process; for several known steps use run_code.";

/**
 * codeMode=primary's tool list: run_code listed first, as the system prompt
 * names it first, and the command tool's description saying it is for one
 * command. Both depend only on the surface, so the list stays byte-stable
 * across steps. Shared by the product turn (api-turn.ts) and unattended runs.
 */
export function primaryCodeModeTools(
	runCode: ToolSet,
	tools: ToolSet,
): ToolSet {
	return {
		...runCode,
		...Object.fromEntries(
			Object.entries(tools).map(([name, definition]) => [
				name,
				leanToolRole(name) === "command"
					? ({
							...definition,
							description:
								`${definition.description ?? ""} ${PRIMARY_COMMAND_NOTE}`.trim(),
						} as typeof definition)
					: definition,
			]),
		),
	};
}
