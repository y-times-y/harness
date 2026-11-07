import { describe, expect, it } from "vitest";
import { posixShellCommand, posixShellQuoted } from "./posix-command";

describe("posixShellCommand", () => {
	it("quotes each argument so spaces and quotes survive", () => {
		expect(posixShellQuoted("acme/app")).toBe("'acme/app'");
		expect(
			posixShellCommand(["git", "clone", "https://example.test/a b"]),
		).toBe("'git' 'clone' 'https://example.test/a b'");
		expect(posixShellCommand(["echo", "it's"])).toBe(`'echo' 'it'\\''s'`);
	});

	it("rejects an empty argv", () => {
		expect(() => posixShellCommand([])).toThrow(
			"A command requires at least one argument.",
		);
	});
});
