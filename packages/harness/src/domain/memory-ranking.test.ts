import { describe, expect, it } from "vitest";
import {
	hybridScores,
	lexicalScores,
	memoryMatchScores,
	memoryTokens,
} from "./memory-ranking";

const line = (path: string, text: string) => ({ path, text });

describe("memory ranking", () => {
	it("tokenizes words, stems plurals and drops filler", () => {
		expect(
			memoryTokens("Add the installs to config.py and new CLI scripts"),
		).toEqual(["install", "config", "py", "cli", "script"]);
		// Short plurals meet the singular; a URL's scheme meets "HTTP".
		expect(memoryTokens("New entity IDs, API keys")).toEqual([
			"entity",
			"id",
			"api",
			"key",
		]);
		expect(memoryTokens("GET https://example.invalid/v1")).toContain("http");
		expect(memoryTokens("the bus is here")).toEqual(["bus", "here"]);
		expect(memoryTokens("SVC_DB_URL")).toEqual([
			"svc_db_url",
			"svc",
			"db",
			"url",
		]);
	});

	it("scores word overlap by rarity, with the topic file as part of the line", () => {
		const lines = [
			line("config.md", "Default timeouts are 10 seconds"),
			line("tooling.md", "Install packages with pnpm"),
			line("people.md", "Sam is on call"),
		];
		const scores = lexicalScores(
			lines,
			"Make the timeout in config.py configurable",
		);
		expect(scores.get(lines[0])).toBeGreaterThan(0);
		expect(scores.get(lines[1])).toBe(0);
		expect(scores.get(lines[2])).toBe(0);
		// The file name alone matches.
		expect(
			lexicalScores(lines, "the people here").get(lines[2]),
		).toBeGreaterThan(0);
	});

	it("adds a saturating lexical part and pulls a strong hit's file neighbours up", () => {
		const hit = line("tooling.md", "CLI scripts use argparse");
		const neighbour = line("tooling.md", "New CLI tools go in tools/");
		const other = line("people.md", "Mara owns the mobile app");
		const lines = [hit, neighbour, other];
		const similarity = new Map([
			[hit, 0.6],
			[neighbour, 0.3],
			[other, 0.31],
		]);
		const none = new Map(lines.map((entry) => [entry, 0]));
		const weights = { lexical: 0.2, half: 4, file: 0.25, strong: 0.5 };
		const scores = hybridScores(lines, similarity, none, weights);
		expect(scores.get(hit)).toBeCloseTo(0.6);
		// 0.3 + 0.25 x (0.6 - 0.3): the neighbour now outranks the unrelated line.
		expect(scores.get(neighbour)).toBeCloseTo(0.375);
		expect(scores.get(other)).toBeCloseTo(0.31);
		// A weak best hit lifts nothing: its file is no evidence for its neighbours.
		const weak = hybridScores(
			lines,
			new Map([
				[hit, 0.45],
				[neighbour, 0.3],
				[other, 0.31],
			]),
			none,
			weights,
		);
		expect(weak.get(neighbour)).toBeCloseTo(0.3);
		// Lexical: bm25 4 is half the weight, and it never exceeds the weight.
		const lexical = new Map([
			[hit, 0],
			[neighbour, 4],
			[other, 1000],
		]);
		const withWords = hybridScores(lines, similarity, lexical, {
			...weights,
			file: 0,
		});
		expect(withWords.get(neighbour)).toBeCloseTo(0.4);
		expect(withWords.get(other)).toBeLessThan(0.31 + 0.2);
	});

	it("ranks a line the request implies above an unrelated near-miss", () => {
		const right = line(
			"config.md",
			"New environment variables use the ACME_ prefix",
		);
		const lines = [
			line(
				"config.md",
				"Default timeouts are 10 seconds unless stated otherwise",
			),
			right,
			line("api.md", "Rate limiting is handled at the gateway"),
		];
		const similarity = new Map([
			[lines[0], 0.64],
			[right, 0.35],
			[lines[2], 0.42],
		]);
		const scores = memoryMatchScores(
			lines,
			similarity,
			"Make the request timeout configurable in config.py",
		);
		expect(scores.get(right) ?? 0).toBeGreaterThan(scores.get(lines[2]) ?? 0);
	});
});
