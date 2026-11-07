import { parseEnvironmentRecipe } from "./project-environment";

/** Missing policy is an admission/configuration problem, not a failed Git operation. */
export class VerificationPolicyFailure extends Error {
	constructor(readonly reason: "missing-checks" | "missing-test-script") {
		super(
			reason === "missing-checks"
				? "Configure project verification checks before automated integration. Work is preserved; no verification receipt or publication was accepted."
				: "A project test script or explicit verification recipe is required for automated integration. Work is preserved; no verification receipt or publication was accepted.",
		);
		this.name = "VerificationPolicyFailure";
	}
}

/** Only the clean baseline may assert independence; default checks remain ordered and serial. */
export function taskVerificationPlan(
	input: Parameters<typeof taskIntegrationChecks>[0],
): string[][] {
	const commands = taskIntegrationChecks(input);
	const groups = input.recipe
		? parseEnvironmentRecipe(input.recipe).parallelChecks
		: [];
	const plan: string[][] = [];
	for (let index = 0; index < commands.length; ) {
		const group = groups.find((candidate) => candidate[0] === commands[index]);
		plan.push(group ?? [commands[index]]);
		index += group?.length ?? 1;
	}
	return plan;
}

/** Choose checks from the clean base, never from model arguments or the imported patch. */
export function taskIntegrationChecks(input: {
	recipe: string | null;
	manifest: string | null;
	files: readonly string[];
}) {
	if (input.recipe) {
		const recipe = parseEnvironmentRecipe(input.recipe);
		const commands = [...new Set([...recipe.verify, ...recipe.checks])];
		if (!commands.length) throw new VerificationPolicyFailure("missing-checks");
		return commands;
	}
	const manifest: unknown = input.manifest ? JSON.parse(input.manifest) : null;
	if (
		!manifest ||
		typeof manifest !== "object" ||
		!("scripts" in manifest) ||
		!manifest.scripts ||
		typeof manifest.scripts !== "object"
	)
		throw new VerificationPolicyFailure("missing-checks");
	const scripts = manifest.scripts as Record<string, unknown>;
	const manager = input.files.includes("pnpm-lock.yaml")
		? "corepack pnpm"
		: input.files.includes("yarn.lock")
			? "corepack yarn"
			: input.files.includes("bun.lock") || input.files.includes("bun.lockb")
				? "bun"
				: "npm";
	const names = ["lint", "typecheck", "test", "build"].filter(
		(name) => typeof scripts[name] === "string" && scripts[name].trim(),
	);
	if (!names.includes("test"))
		throw new VerificationPolicyFailure("missing-test-script");
	return names.map((name) => `${manager} run ${name}`);
}
