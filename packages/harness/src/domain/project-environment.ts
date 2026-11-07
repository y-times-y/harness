import { z } from "zod";

const command = z.string().trim().min(1).max(16_384);
const environmentService = z
	.object({
		name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
		command,
		port: z.number().int().min(1024).max(65535),
		timeoutSeconds: z.number().int().min(1).max(300).default(60),
	})
	.strict();

const secretName = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);

/**
 * Something the setup could not verify (e.g. the dev server without its
 * realtime secret): shown in Settings, never run by the build.
 */
export const unverifiedEnvironmentItem = z
	.object({
		what: z.string().trim().min(1).max(120),
		reason: z.string().trim().min(1).max(300),
		secrets: z.array(secretName).max(10).optional(),
	})
	.strict();
export type UnverifiedEnvironmentItem = z.infer<
	typeof unverifiedEnvironmentItem
>;

export const environmentRecipe = z
	.object({
		version: z.literal(1).default(1),
		install: command.optional(),
		buildSecrets: z.array(secretName).max(100).default([]),
		/** Left out (not defaulted) so setups saved before it keep their build hash. */
		unverified: z.array(unverifiedEnvironmentItem).max(20).optional(),
		verify: z.array(command).max(20).default([]),
		checks: z.array(command).max(20).default([]),
		parallelChecks: z.array(z.array(command).min(2).max(4)).max(10).default([]),
		services: z.array(environmentService).max(12).default([]),
		timeoutSeconds: z.number().int().min(1).max(3600).default(900),
	})
	.strict()
	.superRefine((recipe, ctx) => {
		const checks = [...new Set([...recipe.verify, ...recipe.checks])];
		const grouped = new Set<string>();
		for (const group of recipe.parallelChecks) {
			const start = checks.indexOf(group[0]);
			if (
				start < 0 ||
				group.some(
					(item, index) => checks[start + index] !== item || grouped.has(item),
				)
			) {
				ctx.addIssue({
					code: "custom",
					message:
						"Parallel check groups must contain distinct contiguous checks in declared verification order.",
				});
			}
			for (const item of group) grouped.add(item);
		}
		if (
			new Set(recipe.services.map((service) => service.name)).size !==
			recipe.services.length
		)
			ctx.addIssue({
				code: "custom",
				message: "Service names must be unique.",
			});
		if (
			new Set(recipe.services.map((service) => service.port)).size !==
			recipe.services.length
		)
			ctx.addIssue({
				code: "custom",
				message: "Service ports must be unique.",
			});
	});

export type EnvironmentRecipe = z.infer<typeof environmentRecipe>;
export const ENVIRONMENT_RECIPE_PATH = ".ytimesy/environment.json";

export function parseEnvironmentRecipe(contents: string): EnvironmentRecipe {
	return environmentRecipe.parse(JSON.parse(contents));
}

/** An unverified item's tooltip: why, and the secrets it is missing. */
export function unverifiedItemDetails(item: UnverifiedEnvironmentItem) {
	return item.secrets?.length
		? `${item.reason} Needs ${item.secrets.join(", ")}.`
		: item.reason;
}
