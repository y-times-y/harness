import type { ModelMessage } from "ai";
import { expect, it } from "vitest";
import { IMAGE_PLACEHOLDER, withImagePlaceholders } from "./image-placeholders";

it("replaces every image a text-only model would receive, and nothing else", () => {
	const history: ModelMessage[] = [
		{
			role: "user",
			content: [
				{ type: "text", text: "Match this design" },
				{ type: "image", image: "aGVsbG8=", mediaType: "image/png" },
				{ type: "file", data: "aGVsbG8=", mediaType: "application/pdf" },
			],
		},
		{
			role: "assistant",
			content: [
				{
					type: "tool-call",
					toolCallId: "shot",
					toolName: "view_image",
					input: { path: "a.png" },
				},
			],
		},
		{
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "shot",
					toolName: "view_image",
					output: {
						type: "content",
						value: [
							{ type: "text", text: "a.png" },
							{ type: "image-data", data: "aGVsbG8=", mediaType: "image/png" },
						],
					},
				},
			],
		},
		{ role: "user", content: "Plain text" },
	];
	const placeheld = withImagePlaceholders(history);
	expect(JSON.stringify(placeheld)).not.toContain("image/png");
	expect(placeheld[0].content).toEqual([
		{ type: "text", text: "Match this design" },
		{ type: "text", text: IMAGE_PLACEHOLDER },
		{ type: "file", data: "aGVsbG8=", mediaType: "application/pdf" },
	]);
	expect(placeheld[1]).toBe(history[1]);
	expect(placeheld[3]).toBe(history[3]);
	expect(JSON.stringify(placeheld[2])).toContain(IMAGE_PLACEHOLDER);
	// The saved history keeps its pixels; the same input yields the same prompt.
	expect(JSON.stringify(history)).toContain("image/png");
	expect(withImagePlaceholders(history)).toEqual(placeheld);
});
