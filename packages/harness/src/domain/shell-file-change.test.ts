import { describe, expect, it } from "vitest";
import {
	fileChangesFromShellCommand,
	remainingShellCommandAfterWrites,
} from "./shell-file-change";

describe("fileChangesFromShellCommand", () => {
	it("turns a cat heredoc into an apply_patch-style file add", () => {
		const command = `mkdir -p /tmp/src && cat > /tmp/src/hero.tsx <<'EOF'\nexport const hero = { title: "ytimesy" };\nEOF`;
		expect(fileChangesFromShellCommand(command)).toEqual([
			{
				path: "/tmp/src/hero.tsx",
				change: "add",
				additions: 1,
				deletions: 0,
				preview: 'export const hero = { title: "ytimesy" };',
			},
		]);
		expect(
			remainingShellCommandAfterWrites(
				command,
				fileChangesFromShellCommand(command),
			),
		).toBeNull();
	});

	it("reads apply_patch Add File bodies", () => {
		expect(
			fileChangesFromShellCommand(
				`apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: src/hero.tsx\n+export const hero = { title: "ytimesy" };\n*** End Patch\nPATCH`,
			),
		).toEqual([
			{
				path: "src/hero.tsx",
				change: "add",
				additions: 1,
				deletions: 0,
				preview: 'export const hero = { title: "ytimesy" };',
			},
		]);
	});

	it("keeps a trailing non-write command", () => {
		const command = `cat > todo.py <<'EOF'\nprint(1)\nEOF\n&& python3 todo.py`;
		const writes = fileChangesFromShellCommand(command);
		expect(writes[0]?.path).toBe("todo.py");
		expect(remainingShellCommandAfterWrites(command, writes)).toBe(
			"python3 todo.py",
		);
	});
});
