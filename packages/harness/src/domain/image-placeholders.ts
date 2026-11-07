import type { ModelMessage } from "ai";

export const IMAGE_PLACEHOLDER =
	"[Image omitted: the current model cannot read images.]";

/** A model that cannot read images gets this in its instructions instead of an image tool. */
export const NO_IMAGE_INPUT_INSTRUCTIONS =
	"This model cannot read images: images in the conversation appear as placeholders and no image-viewing tool is offered. Describe what you would need to see, or inspect image files with command-line tools.";

/** Image tools a text-only model is not offered (every surface names its own `view_image`). */
export const IMAGE_VIEWING_TOOLS = ["view_image"] as const;

type Part = { type: string; mediaType?: unknown };

function isImagePart(part: Part) {
	if (part.type === "image" || part.type.startsWith("image-")) return true;
	return (
		(part.type === "file" ||
			part.type === "media" ||
			part.type.startsWith("file-")) &&
		typeof part.mediaType === "string" &&
		part.mediaType.startsWith("image")
	);
}

function withoutImages<T extends Part>(parts: readonly T[]) {
	let changed = false;
	const next = parts.map((part) => {
		if (!isImagePart(part)) return part;
		changed = true;
		return { type: "text", text: IMAGE_PLACEHOLDER } as unknown as T;
	});
	return changed ? next : parts;
}

/**
 * The history as a model without image input can accept it: every image part,
 * in user messages, assistant output and tool results, becomes a short text
 * placeholder. Deterministic, so the same history always yields the same
 * prompt (prompt caches stay valid); the saved history keeps the images.
 */
export function withImagePlaceholders(
	messages: readonly ModelMessage[],
): ModelMessage[] {
	let changed = false;
	const next = messages.map((message): ModelMessage => {
		if (typeof message.content === "string") return message;
		if (message.role === "tool") {
			const content = message.content.map((part) => {
				if (part.type !== "tool-result" || part.output.type !== "content")
					return part;
				const value = withoutImages(part.output.value as readonly Part[]);
				return value === part.output.value
					? part
					: {
							...part,
							output: {
								...part.output,
								value: value as typeof part.output.value,
							},
						};
			});
			if (content.every((part, index) => part === message.content[index]))
				return message;
			changed = true;
			return { ...message, content };
		}
		const content = withoutImages(message.content as readonly Part[]);
		if (content === message.content) return message;
		changed = true;
		return { ...message, content } as ModelMessage;
	});
	return changed ? next : [...messages];
}
