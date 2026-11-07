import type { HarnessModelFamily } from "./harness-model-profile";
import type { InstructionVariant } from "./harness-variant";

/**
 * Per-model instruction tuning (docs/instruction-tuning.md): the behavioural
 * guidance a lean builder turn gets on top of its tools. `baseline` is the
 * v13-lean guidance unchanged; each other profile is one small, principled,
 * task-independent change to it. Every text is a constant, so a profile's
 * prompt is byte-stable across turns and stays in the provider's prompt cache.
 */
export type InstructionProfile = Exclude<InstructionVariant, "default">;

/**
 * The profile each model family gets when the harness variant leaves
 * `instructions` at `default` (production always does). Change one entry
 * when a tuning round (scripts/instruction-tuning.ts) shows a profile beats
 * baseline for that family by more than the noise, over repeats.
 */
export const INSTRUCTION_PROFILE_BY_FAMILY: Readonly<
	Record<HarnessModelFamily, InstructionProfile>
> = {
	openai: "baseline",
	anthropic: "baseline",
	google: "baseline",
	other: "baseline",
};

/** The profile a turn uses: an explicit eval variant, else the family's choice. */
export function instructionProfile(
	variant: InstructionVariant | undefined,
	family: HarnessModelFamily,
	byFamily: Readonly<
		Record<HarnessModelFamily, InstructionProfile>
	> = INSTRUCTION_PROFILE_BY_FAMILY,
): InstructionProfile {
	return !variant || variant === "default" ? byFamily[family] : variant;
}

/**
 * Lines a profile appends to the baseline guidance. Each targets one failure
 * mode seen on the hard set (docs/hard-set.md): weak self-verification,
 * misreading the spec, premature stopping.
 */
export const INSTRUCTION_PROFILE_ADDITIONS = {
	"verify-hard":
		"Verify like the grader: before finishing, write the checks a strict hidden test suite would run, derived from the task text and not from your output: every stated requirement and option, boundary values, empty, malformed and large inputs, unusual ordering, repeated runs, and the exact output format, names and paths. Run them in one script, fix the underlying logic for any failure and rerun. A deliverable that runs elsewhere must also pass from a clean copy with ytimesy-check.",
	"plan-first":
		"Plan first: before your first edit, write a brief plan (at most ten lines) with a numbered checklist of every requirement quoted from the task (outputs, paths, formats, names, limits) and how you will check each one; do not wait for approval. Before finishing, go through the checklist item by item against checks you actually ran, and fix anything unmet or unchecked.",
	persist:
		"Persist: do not end the turn while any requirement is unmet or unverified and you can still act; a passing check of the case you just fixed is not completion, so rerun the full set of checks. After a failure, state why it failed before retrying; after two failures with the same approach, change the approach instead of patching it again. Report a blocker only after trying the alternatives you can try yourself.",
} as const satisfies Partial<Record<InstructionProfile, string>>;

/** `concise`: the whole behavioural guidance in four sentences, replacing baseline's. */
export const CONCISE_GUIDANCE =
	"Reproduce the problem early with a small check, make the complete fix, then rerun it and the existing tests. Follow the task literally; never weaken tests or add options, defaults or limits it did not ask for. Resolve ambiguity yourself: state the assumption and still deliver every output. Before finishing, check every stated requirement, including on an input you made up, and make deliverables work on their own in a clean environment.";
