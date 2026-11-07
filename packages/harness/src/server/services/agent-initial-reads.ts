import { randomUUID } from "node:crypto";
import type { ModelMessage, ToolSet } from "ai";
import { z } from "zod";
import type { ApiAgentEvent } from "../../domain/api-agent-event";
import { InitialAgentReadFailure } from "../../domain/api-turn-failure";

const initialReadOutput = z.json();

/** Execute the existing authorized read tools before the first inference, not a model-authored plan or a substitute for reading. */
export async function prefetchInitialAgentReads(input: {
	messages: ModelMessage[];
	tools: ToolSet;
	/** Fresh unbound OpenAI history only; signed/prefix-bound providers keep their original order. */
	cacheStablePrefix?: boolean;
	signal: AbortSignal;
	onEvent: (event: ApiAgentEvent) => Promise<void>;
}): Promise<ModelMessage[]> {
	if (input.messages.length !== 1 || input.messages[0].role !== "user")
		return input.messages;
	const candidates: {
		name: ConstructorParameters<typeof InitialAgentReadFailure>[0];
		arguments: Record<string, string>;
	}[] = [
		{ name: "read_repository_guidance", arguments: { scope: "." } },
		{ name: "read_environment_report", arguments: {} },
		{ name: "inspect_changes", arguments: {} },
	];
	// Builders get repository instructions as messages, not this tool; their
	// environment report is still prefetched.
	const requests = candidates.filter(
		(request) => typeof input.tools[request.name]?.execute === "function",
	);
	if (!requests.length) return input.messages;
	const settled = await Promise.allSettled(
		requests.map(async (request) => {
			const execute = input.tools[request.name]?.execute;
			if (typeof execute !== "function") return null;
			input.signal.throwIfAborted();
			// These reads occur once in a fresh history. Stable local IDs let unchanged
			// guidance precede task-specific input without defeating prefix caching.
			const id = input.cacheStablePrefix
				? `call_prefetch_${request.name}`
				: `call_prefetch_${randomUUID().replaceAll("-", "")}`;
			await input.onEvent({
				type: "tool-call",
				id,
				name: request.name,
				input: request.arguments,
			});
			let output: z.infer<typeof initialReadOutput>;
			try {
				const value = await execute(request.arguments, {
					toolCallId: id,
					messages: input.messages,
					abortSignal: input.signal,
					context: {},
				});
				input.signal.throwIfAborted();
				output = initialReadOutput.parse(value);
			} catch {
				const failure = new InitialAgentReadFailure(request.name);
				await input.onEvent({
					type: "tool-result",
					id,
					name: request.name,
					output: { error: failure.message },
					failed: true,
				});
				input.signal.throwIfAborted();
				throw failure;
			}
			await input.onEvent({
				type: "tool-result",
				id,
				name: request.name,
				output,
			});
			return { id, name: request.name, arguments: request.arguments, output };
		}),
	);
	input.signal.throwIfAborted();
	const failure = settled.find((result) => result.status === "rejected");
	if (failure?.status === "rejected") throw failure.reason;
	const results = settled.flatMap((result) =>
		result.status === "fulfilled" ? [result.value] : [],
	);
	const reads = results.filter((result) => result !== null);
	return [
		...(input.cacheStablePrefix ? [] : input.messages),
		{
			role: "assistant",
			content: reads.map((read) => ({
				type: "tool-call",
				toolCallId: read.id,
				toolName: read.name,
				input: read.arguments,
			})),
		},
		{
			role: "tool",
			content: reads.map((read) => ({
				type: "tool-result",
				toolCallId: read.id,
				toolName: read.name,
				output: { type: "json", value: read.output },
			})),
		},
		...(input.cacheStablePrefix ? input.messages : []),
	];
}
