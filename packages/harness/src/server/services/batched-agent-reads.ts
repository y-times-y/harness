import { asSchema, type ToolSet, tool } from "ai";
import { z } from "zod";

const readName = z.enum([
	"read_environment_report",
	"inspect_changes",
	"search_files",
	"read_files",
	"read_code",
	"inspect_code_batch",
	"inspect_project_evidence",
	"search_project_memory",
]);
const requestSchema = z.object({
	reads: z
		.array(
			z.object({
				tool: readName,
				arguments: z.record(z.string(), z.json()),
			}),
		)
		.min(2)
		.max(6),
});

/** Explicitly independent reads share a response; existing tools retain authorization, bounds and evidence cursors. */
export function batchedAgentReads(tools: ToolSet, signal: AbortSignal) {
	return tool({
		description:
			"Run two to six independent authorized reads in one call instead of serial inference steps. Only listed read tools are permitted. Supply each tool's ordinary arguments; results retain their original bounds, hashes and continuation cursors. Example: source files + project-memory search. Do not batch a read whose arguments depend on another result. Follow incomplete-result cursors before claiming complete evidence. Repository guidance uses its individual tool so complete-read archival remains intact. No commands, edits, launches, reviews or publication.",
		inputSchema: requestSchema,
		execute: async (request, options) => {
			const { reads } = requestSchema.parse(request);
			const executors = reads.map((read) => {
				const execute = tools[read.tool]?.execute;
				if (!execute)
					throw new Error(
						"A requested read tool is unavailable. No reads started.",
					);
				return execute;
			});
			const abort = options.abortSignal ?? signal;
			abort.throwIfAborted();
			const results = await Promise.allSettled(
				reads.map(async (read, index) => {
					const validate = asSchema(tools[read.tool].inputSchema).validate;
					const validated = validate
						? await validate(read.arguments)
						: undefined;
					if (validated && !validated.success)
						throw new Error("Invalid read arguments.");
					abort.throwIfAborted();
					const result = await executors[index](
						validated?.success ? validated.value : read.arguments,
						{
							...options,
							abortSignal: abort,
							toolCallId: `${options.toolCallId}:read:${index}`,
						},
					);
					if (
						result &&
						typeof result === "object" &&
						Symbol.asyncIterator in result
					)
						throw new Error("Streaming reads require their individual tool.");
					return result;
				}),
			);
			abort.throwIfAborted();
			return {
				reads: results.map((result, index) => ({
					tool: reads[index].tool,
					...(result.status === "fulfilled"
						? { status: "completed", result: result.value }
						: {
								status: "failed",
								instruction:
									"This read failed; no successful evidence for it. Invoke this read individually to inspect its error before continuing.",
							}),
				})),
			};
		},
	});
}
