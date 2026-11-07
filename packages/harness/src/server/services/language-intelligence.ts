import { z } from "zod";

export { WARM_LANGUAGE_INTELLIGENCE_SOURCE as LANGUAGE_INTELLIGENCE_SOURCE } from "./warm-language-intelligence";

export const languageQuery = z.object({
	path: z.string().min(1).max(1000),
	operation: z.enum([
		"definition",
		"references",
		"hover",
		"rename_preview",
		"diagnostics",
		"code_actions",
	]),
	line: z.number().int().min(1),
	column: z.number().int().min(1),
	newName: z.string().min(1).max(200).optional(),
	endLine: z.number().int().min(1).optional(),
	endColumn: z.number().int().min(1).optional(),
	kind: z.string().min(1).max(100).optional(),
});

export const languageQueryResult = z.object({
	language: z.string(),
	operation: languageQuery.shape.operation,
	result: z.unknown(),
	diagnosticsObserved: z.boolean(),
	truncated: z.boolean(),
	serverId: z.number().int().positive().optional(),
});
