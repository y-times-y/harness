import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseEnvText, readEnvFiles, redactionValues } from "./env-file.ts";

describe("parseEnvText", () => {
	it("reads plain, quoted, exported and commented variables", () => {
		const text = [
			"# a comment",
			"PLAIN=value",
			"export EXPORTED=yes-exported",
			"SPACED = spaced value  ",
			'DOUBLE="double # not a comment"',
			"SINGLE='single $literal \\n'",
			"INLINE=abc # trailing comment",
			"HASH=abc#def",
			'ESCAPED="line1\\nline2 \\"quoted\\""',
			"EMPTY=",
			"   # indented comment",
			"not a variable line",
		].join("\n");
		expect(parseEnvText(text)).toEqual([
			{ name: "PLAIN", value: "value" },
			{ name: "EXPORTED", value: "yes-exported" },
			{ name: "SPACED", value: "spaced value" },
			{ name: "DOUBLE", value: "double # not a comment" },
			{ name: "SINGLE", value: "single $literal \\n" },
			{ name: "INLINE", value: "abc" },
			{ name: "HASH", value: "abc#def" },
			{ name: "ESCAPED", value: 'line1\nline2 "quoted"' },
			{ name: "EMPTY", value: "" },
		]);
	});

	it("reads multiline quoted values and keeps the last duplicate", () => {
		const text = [
			'PRIVATE_KEY="-----BEGIN KEY-----',
			"abc",
			'-----END KEY-----"',
			"SINGLE_MULTI='one",
			"two'",
			"AFTER=1",
			"AFTER=2",
		].join("\r\n");
		expect(parseEnvText(text)).toEqual([
			{
				name: "PRIVATE_KEY",
				value: "-----BEGIN KEY-----\nabc\n-----END KEY-----",
			},
			{ name: "SINGLE_MULTI", value: "one\ntwo" },
			{ name: "AFTER", value: "2" },
		]);
	});

	it("keeps an unterminated quote as written", () => {
		expect(parseEnvText('BROKEN="no end\nNEXT=ok')).toEqual([
			{ name: "BROKEN", value: '"no end' },
			{ name: "NEXT", value: "ok" },
		]);
	});
});

describe("readEnvFiles", () => {
	it("reads .env then .env.local and tags the source", () => {
		const folder = fs.mkdtempSync(path.join(os.tmpdir(), "ytimesy-env-"));
		try {
			fs.writeFileSync(path.join(folder, ".env"), "A=1\nB=from-env\n");
			fs.writeFileSync(path.join(folder, ".env.local"), "B=from-local\n");
			expect(readEnvFiles(folder)).toEqual([
				{ name: "A", value: "1", source: ".env" },
				{ name: "B", value: "from-env", source: ".env" },
				{ name: "B", value: "from-local", source: ".env.local" },
			]);
		} finally {
			fs.rmSync(folder, { recursive: true, force: true });
		}
	});
});

describe("redactionValues", () => {
	it("skips short and common values that would blank ordinary text", () => {
		expect(
			redactionValues([
				{ value: "true" },
				{ value: "3000" },
				{ value: "production" },
				{ value: "12345678" },
				{ value: "sk-live-abcdef123456" },
				{ value: "  padded-secret-value " },
			]),
		).toEqual([
			"sk-live-abcdef123456",
			"padded-secret-value",
			"  padded-secret-value ",
		]);
	});
});
