import { z } from "zod";

const windowSchema = z.object({
	usedPercent: z.number().finite().min(0).max(100),
	windowDurationMins: z.number().positive().nullable().optional(),
	resetsAt: z.number().nonnegative().nullable().optional(),
});
const bucketSchema = z.object({
	limitId: z.string().optional().nullable(),
	limitName: z.string().optional().nullable(),
	primary: windowSchema.nullable().optional(),
	secondary: windowSchema.nullable().optional(),
});
const usageSchema = z.object({
	compacting: z.boolean().optional(),
	updatedAt: z.number().nullable().optional(),
	limits: z
		.object({
			rateLimits: bucketSchema.nullable().optional(),
			rateLimitsByLimitId: z
				.record(z.string(), bucketSchema)
				.nullable()
				.optional(),
		})
		.nullable()
		.optional(),
	context: z
		.object({
			last: z.object({ totalTokens: z.number().nonnegative() }),
			modelContextWindow: z.number().positive().nullable(),
		})
		.nullable()
		.optional(),
});
export type CodexUsage = z.infer<typeof usageSchema>;
