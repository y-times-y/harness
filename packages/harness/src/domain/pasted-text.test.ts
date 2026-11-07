import { describe, expect, it } from "vitest";
import {
	isLargePaste,
	isPastedText,
	lineCount,
	nextPastedTextNumber,
	PASTED_TEXT_PEEK,
	PASTED_TEXT_THRESHOLD,
	pastedTextFields,
	pastedTextMeta,
	pastedTextName,
} from "./pasted-text";

describe("pasted text", () => {
	it("keeps short pastes inline and turns large ones into attachments", () => {
		expect(isLargePaste("")).toBe(false);
		expect(isLargePaste("a".repeat(PASTED_TEXT_THRESHOLD.characters))).toBe(
			false,
		);
		expect(isLargePaste("a".repeat(PASTED_TEXT_THRESHOLD.characters + 1))).toBe(
			true,
		);
	});

	it("counts many short lines as large", () => {
		const lines = (count: number) =>
			Array.from({ length: count }, (_, index) => `${index}`).join("\n");
		expect(isLargePaste(lines(PASTED_TEXT_THRESHOLD.lines))).toBe(false);
		expect(isLargePaste(lines(PASTED_TEXT_THRESHOLD.lines + 1))).toBe(true);
	});

	it("counts lines the way an editor shows them", () => {
		expect(lineCount("")).toBe(0);
		expect(lineCount("one")).toBe(1);
		expect(lineCount("one\ntwo")).toBe(2);
		expect(lineCount("one\ntwo\n")).toBe(2);
		expect(lineCount("one\r\ntwo\rthree")).toBe(3);
		expect(lineCount("\n\n")).toBe(2);
	});

	it("numbers several pastes in one draft", () => {
		expect(nextPastedTextNumber([])).toBe(1);
		expect(nextPastedTextNumber(["notes.txt"])).toBe(1);
		expect(nextPastedTextNumber(["pasted-1.txt", "pasted-3.txt"])).toBe(4);
		expect(pastedTextName(2)).toBe("pasted-2.txt");
	});

	it("recognizes pasted text by name and type only", () => {
		expect(
			isPastedText({ name: "pasted-1.txt", mediaType: "text/plain" }),
		).toBe(true);
		expect(
			isPastedText({
				name: "pasted-2.txt",
				mediaType: "text/plain;charset=utf-8",
			}),
		).toBe(true);
		expect(isPastedText({ name: "notes.txt", mediaType: "text/plain" })).toBe(
			false,
		);
		expect(
			isPastedText({ name: "pasted-1.txt", mediaType: "application/pdf" }),
		).toBe(false);
	});

	it("labels the chip with a short line count", () => {
		expect(pastedTextMeta(undefined)).toBe("");
		expect(pastedTextMeta(1)).toBe("1 line");
		expect(pastedTextMeta(84)).toBe("84 lines");
		expect(pastedTextMeta(1200)).toBe("1,200 lines");
	});

	it("keeps the first non-blank lines for the tile", () => {
		expect(pastedTextFields("a\n\n  \nb\nc\nd\ne\n")).toEqual({
			lines: 7,
			peek: "a\nb\nc\nd",
		});
		expect(pastedTextFields("x".repeat(500)).peek).toHaveLength(
			PASTED_TEXT_PEEK.characters,
		);
	});
});
