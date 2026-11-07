import { z } from "zod";
import { isPastedText, PASTED_TEXT_PEEK, pastedTextMeta } from "./pasted-text";

/** A file the user attached to a message. Bytes live in private storage. */
export type MessageAttachment = {
	readonly id: string;
	readonly name: string;
	readonly mediaType: string;
	readonly size: number;
	/** Pasted text only: its line count and first lines, for the tile. */
	readonly lines?: number;
	readonly peek?: string;
};

export const MESSAGE_ATTACHMENT_LIMITS = {
	files: 8,
	fileBytes: 10 * 1024 * 1024,
	totalBytes: 20 * 1024 * 1024,
} as const;

/** Outside every checkout, so attachments are never committed. */
export const AGENT_ATTACHMENT_DIRECTORY = "/tmp/ytimesy-attachments";

export const VIEWABLE_IMAGE_TYPES = [
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
] as const;

export const messageAttachment = z.object({
	id: z.string().uuid(),
	name: z.string().min(1).max(120),
	mediaType: z.string().min(1).max(120),
	size: z.number().int().nonnegative().max(MESSAGE_ATTACHMENT_LIMITS.fileBytes),
	lines: z.number().int().nonnegative().optional(),
	peek: z.string().max(PASTED_TEXT_PEEK.characters).optional(),
});

/** One path segment: no separators, control characters or leading dots. */
export function safeAttachmentName(name: string) {
	const base = name.split(/[\\/]/).pop() ?? "";
	const cleaned = base
		.normalize("NFC")
		.replace(/[^\p{L}\p{N}._ -]/gu, "_")
		.replace(/^[.\s]+/, "")
		.trim()
		.slice(0, 120);
	return cleaned || "attachment";
}

export function attachmentPath(
	attachment: Pick<MessageAttachment, "id" | "name">,
) {
	return `${AGENT_ATTACHMENT_DIRECTORY}/${attachment.id}/${attachment.name}`;
}

export function isViewableImage(mediaType: string) {
	return (VIEWABLE_IMAGE_TYPES as readonly string[]).includes(mediaType);
}

export function attachmentSizeLabel(bytes: number) {
	if (bytes === 0) return "empty";
	return bytes < 1024 * 1024
		? `${Math.max(1, Math.round(bytes / 1024))} KB`
		: `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A tile's short type: the file's extension, else its media subtype. */
export function attachmentKindLabel(name: string, mediaType: string) {
	const extension = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1];
	if (extension) return extension.toUpperCase();
	const subtype = mediaType.split("/")[1]?.split(/[;+.-]/)[0];
	if (subtype === "plain") return "TXT";
	return subtype && subtype.length <= 5 && subtype !== "octet"
		? subtype.toUpperCase()
		: "File";
}

/** What the model reads: where each attached file is and how to inspect it. */
export function withAttachmentNote(
	text: string,
	attachments: readonly MessageAttachment[] | undefined,
) {
	if (!attachments?.length) return text;
	const lines = attachments.map((attachment) =>
		isPastedText(attachment)
			? `- ${attachmentPath(attachment)} (pasted text${attachment.lines === undefined ? "" : `, ${pastedTextMeta(attachment.lines)}`}, ${attachmentSizeLabel(attachment.size)})`
			: `- ${attachmentPath(attachment)} (${attachment.mediaType}, ${attachmentSizeLabel(attachment.size)})`,
	);
	const images = attachments.some((attachment) =>
		isViewableImage(attachment.mediaType),
	);
	const pasted = attachments.some(isPastedText);
	return `${text}\n\nThe user attached ${attachments.length === 1 ? "a file" : "files"}, saved on your machine:\n${lines.join("\n")}${images ? "\nLook at each attached image with view_image (pass the absolute path) before acting on it." : ""}${pasted ? "\nEach pasted text file holds text the user pasted into this message. Read it in full before acting on it." : ""}`;
}

/** Base64 file bytes as the browser sends them, before storage. */
export const incomingAttachments = z
	.array(
		z.object({
			name: z.string().min(1).max(255),
			mediaType: z.string().max(120),
			// An empty file is a valid attachment and encodes to "".
			base64: z
				.string()
				.max(Math.ceil(MESSAGE_ATTACHMENT_LIMITS.fileBytes / 3) * 4)
				.regex(/^(?:[A-Za-z0-9+/]+={0,2})?$/),
		}),
	)
	.max(MESSAGE_ATTACHMENT_LIMITS.files)
	.refine(
		(files) =>
			files.reduce((total, file) => total + base64ByteLength(file.base64), 0) <=
			MESSAGE_ATTACHMENT_LIMITS.totalBytes,
		"Attached files exceed 20 MB in total.",
	);

export type IncomingAttachment = z.infer<typeof incomingAttachments>[number];

export function base64ByteLength(base64: string) {
	const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
	return Math.floor((base64.length * 3) / 4) - padding;
}

/** Keep a well-formed declared type; images are re-detected from their bytes on the server. */
export function declaredMediaType(value: string) {
	const type = value.trim().toLowerCase();
	return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/.test(
		type,
	)
		? type
		: "application/octet-stream";
}
