import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	type HarnessModelFamily,
	harnessModelToolInstructions,
} from "./harness-model-profile";
import {
	DEFAULT_HARNESS_VARIANT,
	HARNESS_VARIANT_VALUES,
	harnessVariantFromFlags,
} from "./harness-variant";
import {
	CONCISE_GUIDANCE,
	INSTRUCTION_PROFILE_ADDITIONS,
	INSTRUCTION_PROFILE_BY_FAMILY,
	type InstructionProfile,
	instructionProfile,
} from "./instruction-profiles";

const CORE = ["bash", "read", "write", "edit"];
const PROFILES = HARNESS_VARIANT_VALUES.instructions.filter(
	(value): value is InstructionProfile => value !== "default",
);
const lean = (
	profile: InstructionProfile,
	family: HarnessModelFamily = "openai",
) => harnessModelToolInstructions(family, false, CORE, profile);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe("instruction profiles", () => {
	it("keeps baseline byte-identical to the v13-lean guidance it replaced", () => {
		// The hash of the text before profiles existed (integrate-2, a0ec52b).
		expect(sha(lean("baseline"))).toBe(
			"0f050a8c8d4f159b8f8dcf7b2bf3a9033b9a57d93561e1ec2d4946ea682054b5",
		);
		expect(harnessModelToolInstructions("openai", false, CORE)).toBe(
			lean("baseline"),
		);
	});

	it("adds exactly one paragraph per additive profile and names it", () => {
		for (const profile of ["verify-hard", "plan-first", "persist"] as const) {
			const text = lean(profile);
			expect(text).toContain(`v13-lean+${profile} (openai)`);
			expect(text.endsWith(INSTRUCTION_PROFILE_ADDITIONS[profile])).toBe(true);
			expect(
				text
					.replace(` ${INSTRUCTION_PROFILE_ADDITIONS[profile]}`, "")
					.replace(`v13-lean+${profile}`, "v13-lean"),
			).toBe(lean("baseline"));
		}
	});

	it("concise replaces the guidance with a much shorter text", () => {
		const text = lean("concise");
		expect(text).toContain("v13-lean+concise");
		expect(text).toContain(CONCISE_GUIDANCE);
		expect(text).toContain("Edit files with edit");
		expect(text).not.toContain("Generalize instead of fitting");
		expect(text.length).toBeLessThan(lean("baseline").length / 2);
	});

	it("is byte-stable, short and task-independent", () => {
		for (const profile of PROFILES) {
			expect(lean(profile)).toBe(lean(profile));
			expect(lean(profile, "google")).toContain("(google)");
		}
		for (const text of Object.values(INSTRUCTION_PROFILE_ADDITIONS)) {
			expect(text.length).toBeLessThan(600);
			expect(text).not.toMatch(/hard set|mvcc|vigenere/i);
		}
		expect(new Set(PROFILES.map((profile) => lean(profile))).size).toBe(
			PROFILES.length,
		);
	});

	it("uses each tool shape's names", () => {
		const gemini = harnessModelToolInstructions(
			"google",
			false,
			[
				"run_shell_command",
				"read_file",
				"write_file",
				"replace",
				"glob",
				"grep_search",
			],
			"persist",
		);
		expect(gemini).toContain("Edit files with replace");
		expect(gemini).toContain(INSTRUCTION_PROFILE_ADDITIONS.persist);
	});

	it("leaves the non-lean surfaces unchanged", () => {
		for (const tools of [["execute_command", "apply_patch"], ["read_file"]])
			expect(
				harnessModelToolInstructions("openai", false, tools, "verify-hard"),
			).toBe(harnessModelToolInstructions("openai", false, tools));
	});

	it("resolves default to the family's profile and explicit values as given", () => {
		expect(DEFAULT_HARNESS_VARIANT.instructions).toBe("default");
		for (const family of ["openai", "anthropic", "google", "other"] as const) {
			expect(INSTRUCTION_PROFILE_BY_FAMILY[family]).toBe("baseline");
			expect(instructionProfile(undefined, family)).toBe("baseline");
			expect(instructionProfile("default", family)).toBe("baseline");
			expect(instructionProfile("concise", family)).toBe("concise");
		}
		const tuned = {
			...INSTRUCTION_PROFILE_BY_FAMILY,
			google: "persist" as const,
		};
		expect(instructionProfile("default", "google", tuned)).toBe("persist");
		expect(instructionProfile("default", "openai", tuned)).toBe("baseline");
		expect(instructionProfile("baseline", "google", tuned)).toBe("baseline");
	});

	it("is selectable as a harness variant flag", () => {
		expect(
			harnessVariantFromFlags(["instructions=verify-hard"]).instructions,
		).toBe("verify-hard");
		expect(() => harnessVariantFromFlags(["instructions=louder"])).toThrow(
			/instructions accepts/,
		);
	});
});
