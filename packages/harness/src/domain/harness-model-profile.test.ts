import { expect, it } from "vitest";
import {
	harnessModelFamily,
	harnessModelToolInstructions,
	reconstructedContextTransition,
} from "./harness-model-profile";

it("requests early executable feedback without sacrificing durable regression coverage", () => {
	const instructions = harnessModelToolInstructions("openai", false);
	expect(instructions).toContain("smallest executable reproduction");
	expect(instructions).toContain("before extensive test scaffolding");
	expect(instructions).toContain("persist regression coverage");
	expect(instructions).toContain("immediately check it");
	expect(instructions).toContain("Do not front-load");
	expect(instructions).toContain(
		"persist regression coverage in existing suites",
	);
	expect(instructions).toContain(
		"without a suite, prefer compact reproducible checks",
	);
	expect(instructions).toContain("never weaken tests");
	expect(instructions).toContain("Preserve every required check");
	expect(instructions).toContain("Derive expected behavior from requirements");
	expect(instructions).toContain("not your patch");
	expect(instructions).toContain("Fix one coherent behavior");
	expect(instructions).toContain("before expanding");
	expect(instructions).toContain("never weaken tests or invent semantics");
});

it("does not send a builder searching for absent planning or delegation tools", () => {
	const instructions = harnessModelToolInstructions("openai", false, [
		"execute_command",
		"apply_patch",
		"run_checks",
		"inspect_changes",
		"read_file",
	]);
	expect(instructions).not.toContain("delegation");
	expect(instructions).toContain("Only offered tools");
});

it("recommends bounded evidence instead of duplicate full reads", () => {
	const instructions = harnessModelToolInstructions("openai", false, [
		"read_file",
	]);
	expect(instructions).toContain("outputView:summary");
	expect(instructions).toContain("configured formatter");
	expect(instructions).toContain("never invent line limits");
	expect(instructions).toContain("match existing style");
	expect(instructions).toContain("Do not reread entire");
});

it("keeps the current user request last and explains reconstructed history without forwarding opaque state", () => {
	const current = { role: "user" as const, content: "Continue" };
	const history = [
		{ role: "assistant" as const, content: "Earlier visible result" },
		current,
	];
	const result = reconstructedContextTransition(history, "next-model");
	expect(result.at(-1)).toBe(current);
	expect(result[1].content).toContain("Native continuation was not reused");
	expect(history).toHaveLength(2);
	expect(reconstructedContextTransition([current], "next-model")).toEqual([
		current,
	]);
});

it("resolves routed provider families without treating all compatible endpoints as OpenAI models", () => {
	expect(harnessModelFamily("openrouter.chat", "anthropic/claude-opus")).toBe(
		"anthropic",
	);
	expect(harnessModelFamily("codex-subscription.responses", "gpt-model")).toBe(
		"openai",
	);
	expect(harnessModelFamily("compatible.chat", "gpt-alias")).toBe("other");
	expect(harnessModelFamily("google.generative-ai", "gemini")).toBe("google");
});

it("does not recommend a native tool unless it is actually offered", () => {
	expect(harnessModelToolInstructions("openai", false)).toContain(
		"replace_text",
	);
	expect(harnessModelToolInstructions("openai", true)).toContain(
		"native apply_patch",
	);
	expect(harnessModelToolInstructions("anthropic", false)).toContain(
		"Signed thinking",
	);
	const freeform = harnessModelToolInstructions("openai", "freeform");
	expect(freeform).toContain("freeform, not JSON");
	expect(freeform).not.toContain("V4A operation schema");
});

it.each(["openai", "anthropic", "google", "other"] as const)(
	"bounds unconditional %s guidance without weakening source or verification contracts",
	(family) => {
		const instructions = harnessModelToolInstructions(family, false);
		expect(instructions.length).toBeLessThan(2200);
		expect(instructions).toContain("Read current source");
		expect(instructions).toContain("required bodies completely");
		expect(instructions).toContain("Preserve every required check");
		expect(instructions).toContain("actual exit and stop status");
		expect(instructions).toContain("execute_command with rg");
		expect(instructions).not.toContain("discover replace_text");
		expect(instructions).not.toContain("oldText");
		expect(instructions).toContain("least expensive safe workflow");
		expect(instructions).toContain("when semantic uncertainty warrants");
		expect(instructions).not.toContain("Use rename_symbol, rename_file");
	},
);

it("gives a shell-shaped surface shell guidance without naming tools it was not offered", () => {
	const instructions = harnessModelToolInstructions("openai", true, [
		"execute_command",
		"continue_command",
		"stop_command",
		"apply_patch",
		"view_image",
		"read_repository_guidance",
	]);
	expect(instructions).toContain("v13-shell");
	expect(instructions).toContain("reproduce the problem");
	for (const absent of ["run_checks", "inspect_changes", "compose_tools"])
		expect(instructions).not.toContain(absent);
	expect(
		harnessModelToolInstructions("openai", true, [
			"execute_command",
			"run_checks",
		]),
	).toContain("v8");
});

it("keeps v13-shell's behavioural guidance on lean surfaces, in their tool names", () => {
	const shell = harnessModelToolInstructions("openai", "freeform", [
		"execute_command",
		"continue_command",
		"stop_command",
		"apply_patch",
		"check_deliverable",
	]);
	const surfaces = [
		["codex", ["exec_command", "write_stdin", "apply_patch", "view_image"]],
		["claude", ["Bash", "Read", "Write", "Edit", "Glob", "Grep"]],
		["core", ["bash", "read", "write", "edit"]],
	] as const;
	for (const [shape, tools] of surfaces) {
		const lean = harnessModelToolInstructions("other", false, tools);
		expect(lean, shape).toContain("v13-lean");
		expect(lean, shape).toContain(`Inspect with ${tools[0]}`);
		for (const line of [
			"Generalize instead of fitting the examples",
			"Implement required behavior literally",
			"Deliverables must work on their own in a fresh environment",
			"map each stated symptom or requirement to a check you actually ran",
			"Fix first:",
			"likely misreading",
			"choose the most reasonable interpretation",
		]) {
			expect(lean, `${shape}: ${line}`).toContain(line);
			expect(shell).toContain(line);
		}
		for (const removed of [
			"continue_command",
			"stop_command",
			"check_deliverable",
			"execute_command",
			"context archive",
		])
			expect(lean, `${shape}: ${removed}`).not.toContain(removed);
	}
});

it("points the lean profile's batching at run_code when it is offered, never at the shell alone", () => {
	const plain = harnessModelToolInstructions("openai", "freeform", [
		"bash",
		"read",
		"write",
		"edit",
	]);
	const coded = harnessModelToolInstructions("openai", "freeform", [
		"bash",
		"read",
		"write",
		"edit",
		"run_code",
	]);
	expect(plain).toContain("Inspect with bash");
	expect(plain).not.toContain("run_code");
	expect(coded).toContain("v13-lean");
	expect(coded).not.toContain("Inspect with bash");
	expect(coded).not.toContain("or from bash when");
	expect(coded).toContain("one run_code program reads several files at once");
	expect(coded).toContain("Generalize instead of fitting the examples");
	// The pre-finish checks go in one program, not one shell command.
	expect(plain).toContain("one combined verification command or script");
	expect(coded).not.toContain("one combined verification command or script");
	expect(coded).toContain(
		"cover any remaining ones in one run_code program running the checks (Promise.all where independent)",
	);
});
