import { asSchema, type ToolSet, tool } from "ai";
import { z } from "zod";
import type { ApiAgentEvent } from "../../domain/api-agent-event";
import {
	type HarnessToolMetric,
	harnessToolName,
	reportedToolFailure,
	toolFailureClass,
	toolMetricCategory,
} from "../../domain/harness-performance";
import { publicToolDetail } from "../../domain/tool-detail";

const reads = new Set([
	"read_file",
	"read_files",
	"read_code",
	"inspect_code",
	"inspect_code_batch",
	"list_files",
	"search_files",
	"read_tool_output",
	"read_environment_report",
	"inspect_changes",
	"read_repository_guidance",
	"search_project_memory",
	"read_project_memory",
	"read_work_plan",
]);
const writes = new Set([
	"apply_patch",
	"replace_text",
	"apply_patches",
	"rename_symbol",
	"rename_file",
	"create_file",
	"execute_command",
	"continue_command",
	"stop_command",
	"run_checks",
	"browser_execute",
]);
const stepId = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
const reference = z
	.object({
		$result: z.object({
			step: stepId,
			path: z.array(z.string().max(100)).max(12),
		}),
	})
	.strict();
const toolComposition = z.object({
	steps: z
		.array(
			z.object({
				id: stepId,
				tool: z.string().min(1).max(80),
				arguments: z.record(z.string(), z.json()),
				dependsOn: z.array(stepId).max(8).default([]),
			}),
		)
		.min(1)
		.max(8),
});
type Step = z.infer<typeof toolComposition>["steps"][number];
type Outcome = {
	id: string;
	tool: string;
	status: "completed" | "failed" | "blocked" | "waiting";
	result?: unknown;
};

function incompleteCommand(result: unknown): boolean {
	if (Array.isArray(result)) return result.some(incompleteCommand);
	if (!result || typeof result !== "object") return false;
	return (
		("status" in result &&
			["running", "interrupted", "stopped"].includes(String(result.status))) ||
		("stopped" in result && result.stopped != null) ||
		("outputDeferred" in result && result.outputDeferred === true) ||
		("retryRequired" in result && result.retryRequired === true)
	);
}

function references(value: unknown): string[] {
	const parsed = reference.safeParse(value);
	if (parsed.success) return [parsed.data.$result.step];
	if (Array.isArray(value)) return value.flatMap(references);
	return value && typeof value === "object"
		? Object.values(value).flatMap(references)
		: [];
}

function resolveArguments(
	value: unknown,
	results: Map<string, Outcome>,
): unknown {
	const parsed = reference.safeParse(value);
	if (parsed.success) {
		let result: unknown = results.get(parsed.data.$result.step)?.result;
		for (const key of parsed.data.$result.path) {
			if (
				!result ||
				typeof result !== "object" ||
				!Object.hasOwn(result, key) ||
				["__proto__", "constructor", "prototype"].includes(key)
			)
				throw new Error("Result reference does not exist.");
			result = (result as Record<string, unknown>)[key];
		}
		return result;
	}
	if (Array.isArray(value))
		return value.map((entry) => resolveArguments(entry, results));
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [
				key,
				resolveArguments(entry, results),
			]),
		);
	return value;
}

/** Forward-only dataflow is bounded and inspectable; no model-authored code executes on the trusted server. */
export function composedAgentTools(input: {
	tools: ToolSet;
	signal: AbortSignal;
	onEvent: (event: ApiAgentEvent) => Promise<void>;
	onToolMetric?: (metric: HarnessToolMetric) => void;
}): ToolSet {
	if (
		!Object.entries(input.tools).some(
			([name, definition]) =>
				(reads.has(name) || writes.has(name)) &&
				definition.execute &&
				definition.type !== "provider",
		)
	)
		return input.tools;
	const readKeys = new Set<string>();
	return {
		...input.tools,
		compose_tools: tool({
			description:
				'Execute up to eight authorized tool steps with result-dependent arguments without an intervening inference. Use the ordinary tool schemas (discover unfamiliar tools first). Argument reference: {"$result":{"step":"launch","path":["id"]}}. Steps reference only earlier ids listed in dependsOn. Independent reads run together; a command/edit must depend on every earlier step, and subsequent steps depend on that mutation. Failed, deferred-instruction or still-running dependencies block successors. Commands are NOT silently waited/restarted. Leaves retain individual visible receipts, hashes, cursors and authorization. No arbitrary JavaScript, task launches, publication, provider tools or image payloads.',
			inputSchema: toolComposition,
			execute: async (raw, options) => {
				const { steps } = toolComposition.parse(raw);
				const previous = new Set<string>();
				let lastMutation: string | undefined;
				for (const step of steps) {
					if (
						previous.has(step.id) ||
						step.dependsOn.some((id) => !previous.has(id)) ||
						references(step.arguments).some(
							(id) => !step.dependsOn.includes(id),
						)
					)
						throw new Error(
							"Duplicate, forward or undeclared dependency. No tools started.",
						);
					const definition = input.tools[step.tool];
					if (
						(!reads.has(step.tool) && !writes.has(step.tool)) ||
						!definition?.execute ||
						definition.type === "provider"
					)
						throw new Error(
							"Tool is not available for composition. No tools started.",
						);
					if (
						(lastMutation && !step.dependsOn.includes(lastMutation)) ||
						(writes.has(step.tool) &&
							[...previous].some((id) => !step.dependsOn.includes(id)))
					)
						throw new Error(
							"Commands and edits require explicit serial dependencies. No tools started.",
						);
					if (writes.has(step.tool)) lastMutation = step.id;
					if (!references(step.arguments).length) {
						const validate = asSchema(definition.inputSchema).validate;
						const parsed = validate
							? await validate(step.arguments)
							: undefined;
						if (parsed && !parsed.success)
							throw new Error("Invalid composed arguments. No tools started.");
					}
					previous.add(step.id);
				}
				const signal = options.abortSignal
					? AbortSignal.any([input.signal, options.abortSignal])
					: input.signal;
				const results = new Map<string, Outcome>();
				async function execute(step: Step): Promise<void> {
					const id = `${options.toolCallId}:step:${step.id}`;
					const started = performance.now();
					let repeatedRead = false;
					let announced = false;
					try {
						signal.throwIfAborted();
						const args = resolveArguments(step.arguments, results);
						const key = JSON.stringify([step.tool, args]);
						repeatedRead = reads.has(step.tool) && readKeys.has(key);
						if (reads.has(step.tool)) readKeys.add(key);
						await input.onEvent({
							type: "tool-call",
							id,
							name: step.tool,
							input: args,
						});
						announced = true;
						const definition = input.tools[step.tool];
						const validate = asSchema(definition.inputSchema).validate;
						const parsed = validate ? await validate(args) : undefined;
						if (parsed && !parsed.success)
							throw new Error("Invalid composed tool arguments.");
						const executor = definition.execute;
						if (!executor) throw new Error("Tool is unavailable.");
						const result = await executor(
							parsed?.success ? parsed.value : args,
							{ ...options, toolCallId: id, abortSignal: signal },
						);
						if (
							result &&
							typeof result === "object" &&
							Symbol.asyncIterator in result
						)
							throw new Error("Streaming tools require individual execution.");
						signal.throwIfAborted();
						const status = reportedToolFailure(result)
							? "failed"
							: incompleteCommand(result)
								? "waiting"
								: "completed";
						results.set(step.id, {
							id: step.id,
							tool: step.tool,
							status,
							result,
						});
						await input.onEvent({
							type: "tool-result",
							id,
							name: step.tool,
							output: result,
							...(status === "failed" ? { failed: true } : {}),
						});
					} catch (error) {
						signal.throwIfAborted();
						if (!announced)
							await input.onEvent({
								type: "tool-call",
								id,
								name: step.tool,
								input: step.arguments,
							});
						results.set(step.id, {
							id: step.id,
							tool: step.tool,
							status: "failed",
							result:
								"Tool failed; inspect its state individually before retrying. Partial effects may exist.",
						});
						await input.onEvent({
							type: "tool-result",
							id,
							name: step.tool,
							output: publicToolDetail(
								error instanceof Error ? error.message : "Tool failed.",
							),
							failed: true,
						});
					} finally {
						const outcome = results.get(step.id);
						try {
							input.onToolMetric?.({
								tool_name: harnessToolName.parse(step.tool),
								category: toolMetricCategory(step.tool),
								duration_ms: Math.max(0, performance.now() - started),
								outcome: outcome?.status === "failed" ? "failed" : "completed",
								error_class:
									outcome?.status === "failed"
										? "execution"
										: toolFailureClass(outcome?.result),
								repeated_read: repeatedRead,
							});
						} catch {
							/* Metrics cannot interrupt execution. */
						}
					}
				}
				while (results.size < steps.length) {
					signal.throwIfAborted();
					const ready = steps.filter(
						(step) =>
							!results.has(step.id) &&
							step.dependsOn.every((id) => results.has(id)),
					);
					for (const step of ready.filter((step) =>
						step.dependsOn.some(
							(id) => results.get(id)?.status !== "completed",
						),
					))
						results.set(step.id, {
							id: step.id,
							tool: step.tool,
							status: "blocked",
						});
					await Promise.all(
						ready
							.filter((step) => !results.has(step.id))
							.slice(0, 4)
							.map(execute),
					);
				}
				return {
					ok: [...results.values()].every(
						(result) => result.status === "completed",
					),
					status: [...results.values()].every(
						(result) => result.status === "completed",
					)
						? "completed"
						: "incomplete",
					steps: steps.map((step) => results.get(step.id)),
				};
			},
		}),
	};
}
