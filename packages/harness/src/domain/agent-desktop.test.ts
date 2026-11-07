import { describe, expect, it } from "vitest";
import {
	leanVisualQaInstructions,
	PR_EVIDENCE_INSTRUCTION,
	visualQaInstructions,
} from "./agent-desktop";

it("says when to check the UI and asks for screenshot evidence in the report", () => {
	const text = visualQaInstructions();
	expect(text).toContain("affects what a user sees");
	expect(text).toContain("before reporting done");
	expect(text).toContain("what the screenshot showed");
	expect(text).toContain("browser_screenshot");
	expect(text).toContain("browser_execute");
	expect(text).toContain("xdotool");
});

describe("pull request evidence line", () => {
	it("adds one ytimesy-evidence line only with prEvidence on", () => {
		const tools = { command: "bash", image: "read" };
		expect(leanVisualQaInstructions(tools)).not.toContain("ytimesy-evidence");
		const on = leanVisualQaInstructions(tools, { prEvidence: true });
		expect(on).toBe(
			`${leanVisualQaInstructions(tools)} ${PR_EVIDENCE_INSTRUCTION}`,
		);
		expect(PR_EVIDENCE_INSTRUCTION).toContain("ytimesy-evidence capture");
	});
});
