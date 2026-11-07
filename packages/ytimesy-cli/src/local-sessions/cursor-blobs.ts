/**
 * Cursor's agent blob store, shared by the Cursor CLI (`store.db` per chat) and the
 * Cursor app (`agentKv:blob:<hex>` rows in state.vscdb). Content-addressed blobs:
 * - Message blobs are JSON in the AI SDK message shape: `{role: system|user|assistant|
 *   tool, content: string | parts[], providerOptions?}` with `text`, `reasoning`,
 *   `tool-call {toolCallId, toolName, args}` and `tool-result {toolCallId, toolName,
 *   result}` parts. `providerOptions.cursor.highLevelToolCallResult.output` on a tool
 *   message carries the structured result (`success` / `failure` with `exitCode` for Shell).
 * - The conversation root is a protobuf message whose repeated field 1 holds the
 *   32-byte ids of the message blobs in order, and field 9 the workspace URI.
 * Verified on cursor-agent 2026.10.01 and Cursor 3.28.5 (composer `_v` 13-18).
 * Compaction in this store was not observed; user messages that are only injected
 * context (`<user_info>`, `<rules>`, ...) are skipped and `<user_query>` is unwrapped.
 */
import type { SessionEvent } from "./events.ts";
import {
	asArray,
	asNumber,
	asObject,
	asString,
	type JsonObject,
} from "./io.ts";
import { exitCodeFromText, stringifyValue } from "./tool-calls.ts";

export interface ProtobufField {
	field: number;
	/** Varint value, or the bytes of a length-delimited field. */
	value: number | Buffer;
}

/** Top-level fields of a protobuf message; undefined when the bytes are not one. */
export function decodeProtobuf(buffer: Buffer): ProtobufField[] | undefined {
	const fields: ProtobufField[] = [];
	let offset = 0;
	const varint = (): number | undefined => {
		let result = 0;
		let scale = 1;
		for (let index = 0; index < 10; index++) {
			if (offset >= buffer.length) return undefined;
			const byte = buffer[offset++] as number;
			result += (byte & 0x7f) * scale;
			if ((byte & 0x80) === 0) return result;
			scale *= 128;
		}
		return undefined;
	};
	while (offset < buffer.length) {
		const key = varint();
		if (key === undefined) return undefined;
		const field = Math.floor(key / 8);
		const wire = key % 8;
		if (field === 0) return undefined;
		if (wire === 0) {
			const value = varint();
			if (value === undefined) return undefined;
			fields.push({ field, value });
		} else if (wire === 2) {
			const length = varint();
			if (length === undefined || offset + length > buffer.length)
				return undefined;
			fields.push({ field, value: buffer.subarray(offset, offset + length) });
			offset += length;
		} else if (wire === 1) {
			offset += 8;
		} else if (wire === 5) {
			offset += 4;
		} else {
			return undefined;
		}
	}
	return offset === buffer.length ? fields : undefined;
}

export interface ConversationRoot {
	/** Message blob ids (hex), in conversation order. */
	messageIds: string[];
	/** Workspace folder URI (`file:///...`) when recorded. */
	workspaceUri?: string;
}

export function decodeConversationRoot(
	buffer: Buffer,
): ConversationRoot | undefined {
	const fields = decodeProtobuf(buffer);
	if (!fields) return undefined;
	const messageIds: string[] = [];
	let workspaceUri: string | undefined;
	for (const { field, value } of fields) {
		if (!Buffer.isBuffer(value)) continue;
		if (field === 1 && value.length === 32)
			messageIds.push(value.toString("hex"));
		if (field === 9 && workspaceUri === undefined) {
			const text = value.toString("utf8");
			if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) workspaceUri = text;
		}
	}
	return { messageIds, workspaceUri };
}

/** The app stores the root as `~` + base64 in composerData.conversationState. */
export function decodeConversationState(
	state: string | undefined,
): ConversationRoot | undefined {
	if (!state?.startsWith("~") || state.length < 3) return undefined;
	try {
		return decodeConversationRoot(Buffer.from(state.slice(1), "base64"));
	} catch {
		return undefined;
	}
}

export function parseMessageBlob(
	data: Uint8Array | string | undefined,
): JsonObject | undefined {
	if (data === undefined) return undefined;
	const text =
		typeof data === "string" ? data : Buffer.from(data).toString("utf8");
	if (!text.startsWith("{")) return undefined;
	try {
		const value: unknown = JSON.parse(text);
		const object = asObject(value);
		return object && typeof object.role === "string" ? object : undefined;
	} catch {
		return undefined;
	}
}

function contentParts(content: unknown): JsonObject[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return asArray(content)
		.map((part) => asObject(part))
		.filter((part): part is JsonObject => !!part);
}

const SUMMARY_TAGS = [
	"<conversation_summary>",
	"<previous_conversation_summary>",
	"<summary>",
];

/**
 * What the person typed: the `<user_query>` body when present; undefined for messages
 * that are only injected context blocks.
 */
export function cursorUserText(text: string): string | undefined {
	const query = /<user_query>([\s\S]*?)<\/user_query>/.exec(text);
	if (query) return query[1]?.trim() || undefined;
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	const withoutBlocks = trimmed
		.replace(/<([a-z_][a-z0-9_-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi, "")
		.trim();
	return withoutBlocks ? trimmed : undefined;
}

function highLevelResult(
	message: JsonObject,
	part: JsonObject,
): JsonObject | undefined {
	const fromPart = asObject(
		asObject(asObject(part.providerOptions)?.cursor)?.highLevelToolCallResult,
	);
	if (fromPart) return fromPart;
	return asObject(
		asObject(asObject(message.providerOptions)?.cursor)
			?.highLevelToolCallResult,
	);
}

function resultText(part: JsonObject): string {
	const result = part.result;
	if (typeof result === "string") return result;
	const texts = asArray(part.experimental_content)
		.map((item) => asString(asObject(item)?.text))
		.filter(Boolean);
	if (texts.length > 0) return texts.join("\n");
	return stringifyValue(result);
}

/** The model named in the system message's prompt fingerprint. */
export function blobModel(message: JsonObject): string | undefined {
	return asString(
		asObject(
			asObject(asObject(message.providerOptions)?.cursor)
				?.systemPromptFingerprint,
		)?.model,
	);
}

/** Events for one message blob. */
export function* blobMessageEvents(
	message: JsonObject,
): Generator<SessionEvent> {
	const role = message.role;
	if (role === "user") {
		const text = contentParts(message.content)
			.map((part) => asString(part.text) ?? "")
			.join("\n");
		if (SUMMARY_TAGS.some((tag) => text.trimStart().startsWith(tag))) {
			yield { type: "compaction", text: text.trim() };
			return;
		}
		const typed = cursorUserText(text);
		if (typed) yield { type: "message", role: "user", text: typed };
		return;
	}
	if (role === "assistant") {
		for (const part of contentParts(message.content)) {
			if (part.type === "text" && asString(part.text)?.trim())
				yield {
					type: "message",
					role: "assistant",
					text: asString(part.text) as string,
				};
			else if (part.type === "reasoning" && asString(part.text)?.trim())
				yield { type: "thinking", text: asString(part.text) as string };
			else if (part.type === "tool-call")
				yield {
					type: "tool_call",
					callId: asString(part.toolCallId),
					name: asString(part.toolName) ?? "unknown_tool",
					input: part.args ?? part.input ?? {},
				};
		}
		return;
	}
	if (role === "tool") {
		for (const part of contentParts(message.content)) {
			if (part.type !== "tool-result") continue;
			const output = resultText(part);
			const high = highLevelResult(message, part);
			const outcome = asObject(high?.output);
			const failure = asObject(outcome?.failure);
			const success = asObject(outcome?.success);
			const isShell = /^(shell|bash|run_terminal)/i.test(
				asString(part.toolName) ?? "",
			);
			let exitCode: number | undefined;
			if (isShell) {
				exitCode =
					asNumber(failure?.exitCode) ??
					asNumber(success?.exitCode) ??
					exitCodeFromText(output) ??
					(success ? 0 : undefined);
			}
			yield {
				type: "tool_result",
				callId: asString(part.toolCallId),
				output,
				exitCode,
				isError:
					high?.isError === true ||
					(failure !== undefined && !isShell) ||
					(exitCode !== undefined && exitCode !== 0) ||
					part.isError === true,
			};
		}
	}
}
