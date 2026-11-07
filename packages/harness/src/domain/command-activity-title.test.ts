import { describe, expect, it } from "vitest";
import { commandActivityTitle } from "./command-activity-title";

describe("command activity labels", () => {
	it.each([
		["pnpm test", "Run tests"],
		["corepack pnpm run build", "Build project"],
		["/bin/bash -lc 'git status --short'", "Check working tree"],
		["cd /repo && git diff", "Inspect changes"],
		["gh issue list --state open", "Inspect repository issues"],
		["pnpm test && git push", "Run shell commands"],
		["echo pnpm test", "Run shell command"],
		["python3 custom.py", "Run shell command"],
	])("labels %s without claiming success", (command, title) => {
		expect(commandActivityTitle(command)).toBe(title);
	});
});
