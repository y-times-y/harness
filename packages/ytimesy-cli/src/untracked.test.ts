import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	filterUntrackedFiles,
	keyMaterialReason,
	secretLikeName,
	UNTRACKED_MAX_BYTES,
} from "./untracked.ts";

describe("secretLikeName", () => {
	it.each([
		".env",
		".env.local",
		".env.example",
		"config/.env.production",
		"server.pem",
		"tls.key",
		"id_rsa",
		"id_rsa.pub",
		"cert.p12",
		"credentials.json",
		"credentials-prod.json",
		"service-account.json",
		"deploy/service-account-ci.json",
	])("%s is secret-like", (name) => {
		expect(secretLikeName(name)).toBe(true);
	});

	it.each([
		"src/env.ts",
		"keyboard.ts",
		"notes.md",
		"credentials.ts",
		"docs/keys.md",
	])("%s is fine", (name) => {
		expect(secretLikeName(name)).toBe(false);
	});
});

describe("keyMaterialReason", () => {
	it("finds key material", () => {
		expect(keyMaterialReason("-----BEGIN RSA PRIVATE KEY-----\nabc")).toMatch(
			/private key/,
		);
		expect(keyMaterialReason("-----BEGIN OPENSSH PRIVATE KEY-----")).toMatch(
			/private key/,
		);
		expect(keyMaterialReason("token = sk-proj-abcdefghijklmnopqrstuv")).toMatch(
			/sk-/,
		);
		expect(keyMaterialReason(`x ghp_${"a".repeat(36)} y`)).toMatch(/ghp_/);
		expect(keyMaterialReason(`github_pat_${"A1_".repeat(10)}`)).toMatch(
			/github_pat_/,
		);
		expect(keyMaterialReason("aws AKIAABCDEFGHIJKLMNOP")).toMatch(/AKIA/);
		expect(keyMaterialReason("xoxb-1234567890-abcdef")).toMatch(/Slack/);
	});

	it("leaves ordinary text alone", () => {
		expect(keyMaterialReason("ask-for-help task-runner desk-lamp")).toBeNull();
		expect(keyMaterialReason("sk-short")).toBeNull();
		expect(keyMaterialReason("const AKIA = 1; // AKIAshort")).toBeNull();
		expect(keyMaterialReason("BEGIN PUBLIC KEY")).toBeNull();
	});
});

describe("filterUntrackedFiles", () => {
	let root: string;
	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "ytimesy-untracked-"));
	});
	afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

	it("includes ordinary files and skips each risky one with a reason", () => {
		const write = (name: string, content: string | Buffer) => {
			fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
			fs.writeFileSync(path.join(root, name), content);
		};
		write("notes.md", "plan");
		write("src/new.ts", "export const x = 1;");
		write(".env.local", "A=1");
		write("big.bin", Buffer.alloc(UNTRACKED_MAX_BYTES));
		write("keys.txt", "AKIAABCDEFGHIJKLMNOP");
		write("deploy.pem", "x");
		fs.symlinkSync("/etc/hosts", path.join(root, "link"));
		const result = filterUntrackedFiles(root, [
			"notes.md",
			"src/new.ts",
			".env.local",
			"big.bin",
			"keys.txt",
			"deploy.pem",
			"link",
			"gone.txt",
		]);
		expect(result.included.map((file) => file.path)).toEqual([
			"notes.md",
			"src/new.ts",
			"link",
		]);
		expect(result.skipped.map((file) => [file.path, file.reason])).toEqual([
			[".env.local", "secret-like name"],
			["big.bin", "larger than 5 MB"],
			["keys.txt", "contains an AWS key (AKIA…)"],
			["deploy.pem", "secret-like name"],
			["gone.txt", "could not be read"],
		]);
	});
});
