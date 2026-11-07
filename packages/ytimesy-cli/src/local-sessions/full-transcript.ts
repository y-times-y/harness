/**
 * Full, untruncated, grep-friendly Markdown copy of a session: every user and
 * assistant message, every tool call with its full input and complete output,
 * timestamps and source compaction summaries, with images written as separate
 * files. Bookkeeping records (Claude attachments, file-history snapshots, system
 * records, the duplicate toolUseResult copies, queue / bridge / last-prompt lines;
 * Codex token counts, world state, developer instructions; OpenCode step parts;
 * Grok hooks) are dropped. Streams the source forward and writes as it goes.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { humanPromptText, toolResultText } from "./claude.ts";
import {
	codexUserPromptText,
	isCodeModeWrapper,
	messageText,
	parseCallOutput,
	readCodexSessionMeta,
	rolloutUsesItemEvents,
	unwrapRecord,
} from "./codex.ts";
import { cursorAgentConversation } from "./cursor-agent.ts";
import { cursorComposerConversation } from "./cursor-app.ts";
import type { SessionEvent } from "./events.ts";
import { parseGeminiSession } from "./gemini.ts";
import { extractUserQuery, readSummary, updateOf } from "./grok.ts";
import {
	asArray,
	asNumber,
	asObject,
	asString,
	fileUrlToPath,
	type JsonObject,
	linesForward,
	parseJsonObject,
} from "./io.ts";
import {
	databaseMessages,
	legacyMessages,
	type OpencodeMessage,
	openOpencodeDatabase,
} from "./opencode.ts";
import { piBranchEntries, readPiHeader, textBlocks } from "./pi.ts";
import {
	commandFromArgv,
	exitCodeFromText,
	stringifyValue,
} from "./tool-calls.ts";
import type { SessionRef } from "./types.ts";

export type TranscriptEvent =
	| {
			type: "message";
			role: "user" | "assistant";
			text: string;
			at?: string;
			injected?: boolean;
	  }
	| { type: "thinking"; text: string; at?: string }
	| { type: "compaction"; text: string; at?: string }
	| {
			type: "tool_call";
			callId?: string;
			name: string;
			input: string;
			at?: string;
	  }
	| {
			type: "tool_result";
			callId?: string;
			output: string;
			isError?: boolean;
			exitCode?: number;
			at?: string;
	  }
	| { type: "image"; mimeType: string; base64: string; at?: string };

export interface FullTranscriptOptions {
	/** Markdown file to write. */
	outputFile: string;
	/** Where images go; defaults to `<outputFile without extension>-images/` next to it. */
	imagesDirectory?: string;
	/** Include readable reasoning text (opaque signatures are never written). */
	includeThinking?: boolean;
	/** Secret values replaced by [REDACTED] everywhere in the output. */
	redactValues?: readonly string[];
	home?: string;
}

export interface FullTranscriptResult {
	transcriptFile: string;
	/** Image files written, relative to the transcript file's directory. */
	images: string[];
	bytesWritten: number;
	/** Numbered message sections written. */
	sections: number;
	toolCalls: number;
}

const IMAGE_EXTENSIONS: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/jpg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"application/pdf": "pdf",
};
const FLUSH_BYTES = 1024 * 1024;

function prettyInput(input: unknown): string {
	if (typeof input === "string") {
		const parsed = input.trimStart().startsWith("{")
			? parseJsonObject(input)
			: undefined;
		return parsed ? JSON.stringify(parsed, null, 2) : input;
	}
	return JSON.stringify(input ?? {}, null, 2) ?? "";
}

function fenceFor(text: string): string {
	let longest = 0;
	for (const match of text.matchAll(/`+/g))
		longest = Math.max(longest, match[0].length);
	return "`".repeat(Math.max(3, longest + 1));
}

function dataUrlImage(
	url: string | undefined,
): { mimeType: string; base64: string } | undefined {
	const match = url ? /^data:([^;,]+);base64,(.*)$/s.exec(url) : null;
	return match?.[1] && match[2]
		? { mimeType: match[1], base64: match[2] }
		: undefined;
}

class MarkdownTranscriptWriter {
	private readonly fd: number;
	private buffer: string[] = [];
	private bufferedBytes = 0;
	bytesWritten = 0;
	sections = 0;
	toolCalls = 0;
	readonly images: string[] = [];
	private openRole: "user" | "assistant" | undefined;
	private readonly secrets: string[];
	private readonly imagesRelative: string;

	constructor(
		private readonly options: FullTranscriptOptions,
		private readonly imagesDirectory: string,
	) {
		fs.mkdirSync(path.dirname(options.outputFile), { recursive: true });
		this.fd = fs.openSync(options.outputFile, "w");
		this.secrets = [
			...new Set((options.redactValues ?? []).filter(Boolean)),
		].sort((a, b) => b.length - a.length);
		this.imagesRelative =
			path.relative(path.dirname(options.outputFile), imagesDirectory) || ".";
	}

	header(lines: string[]): void {
		this.write(`${lines.join("\n")}\n`);
	}

	event(event: TranscriptEvent): void {
		switch (event.type) {
			case "message":
				if (!event.text.trim()) return;
				if (this.openRole === event.role)
					this.write(`\n${event.injected ? "(context)\n\n" : ""}`);
				else
					this.section(
						event.role,
						event.at,
						event.injected ? "context" : undefined,
					);
				this.write(`${event.text.trim()}\n`);
				return;
			case "compaction":
				if (!event.text.trim()) return;
				this.section("user", event.at, "compaction summary");
				this.write(`${event.text.trim()}\n`);
				this.openRole = undefined;
				return;
			case "thinking":
				if (!this.options.includeThinking || !event.text.trim()) return;
				this.ensureAssistantSection(event.at);
				this.write(`\n### thinking\n\n${this.fenced(event.text)}`);
				return;
			case "tool_call":
				this.ensureAssistantSection(event.at);
				this.toolCalls++;
				this.write(
					`\n### tool: ${event.name}${event.callId ? ` (${event.callId})` : ""}\n\n${this.fenced(event.input)}`,
				);
				return;
			case "tool_result": {
				if (!this.openRole) this.section("assistant", event.at);
				const status = [
					event.exitCode === undefined ? undefined : `exit ${event.exitCode}`,
					event.isError ? "error" : undefined,
				]
					.filter(Boolean)
					.join(", ");
				const label = `#### result${event.callId ? ` (${event.callId})` : ""}${status ? ` [${status}]` : ""}`;
				this.write(`\n${label}\n\n${this.fenced(event.output)}`);
				return;
			}
			case "image": {
				const extension = IMAGE_EXTENSIONS[event.mimeType] ?? "bin";
				const name = `image-${String(this.images.length + 1).padStart(4, "0")}.${extension}`;
				fs.mkdirSync(this.imagesDirectory, { recursive: true });
				fs.writeFileSync(
					path.join(this.imagesDirectory, name),
					Buffer.from(event.base64, "base64"),
				);
				const relative = path.join(this.imagesRelative, name);
				this.images.push(relative);
				if (!this.openRole) this.section("user", event.at);
				this.write(`\n![${name}](${relative})\n`);
				return;
			}
		}
	}

	close(): void {
		this.flush();
		fs.closeSync(this.fd);
	}

	private ensureAssistantSection(at: string | undefined): void {
		if (this.openRole !== "assistant") this.section("assistant", at);
	}

	private section(
		role: "user" | "assistant",
		at: string | undefined,
		note?: string,
	): void {
		this.sections++;
		this.openRole = role;
		const parts = [
			`## ${this.sections} ${role}`,
			note ? `(${note})` : undefined,
			at ? `· ${at}` : undefined,
		];
		this.write(`\n${parts.filter(Boolean).join(" ")}\n\n`);
	}

	private fenced(text: string): string {
		const fence = fenceFor(text);
		return `${fence}\n${text.endsWith("\n") ? text : `${text}\n`}${fence}\n`;
	}

	private write(text: string): void {
		let output = text;
		for (const secret of this.secrets)
			if (output.includes(secret))
				output = output.split(secret).join("[REDACTED]");
		this.buffer.push(output);
		this.bufferedBytes += output.length;
		if (this.bufferedBytes >= FLUSH_BYTES) this.flush();
	}

	private flush(): void {
		if (this.buffer.length === 0) return;
		const bytes = Buffer.from(this.buffer.join(""), "utf8");
		fs.writeSync(this.fd, bytes);
		this.bytesWritten += bytes.length;
		this.buffer = [];
		this.bufferedBytes = 0;
	}
}

function* claudeEvents(ref: SessionRef): Generator<TranscriptEvent> {
	const seenBlocks = new Set<string>();
	const shellCalls = new Set<string>();
	for (const line of linesForward(ref.location)) {
		if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"'))
			continue;
		const record = parseJsonObject(line);
		if (!record || record.isSidechain === true) continue;
		const at = asString(record.timestamp);
		const message = asObject(record.message);
		if (record.type === "assistant") {
			if (record.isApiErrorMessage === true || message?.model === "<synthetic>")
				continue;
			const messageId = asString(message?.id) ?? asString(record.uuid) ?? "";
			if (typeof message?.content === "string")
				yield { type: "message", role: "assistant", text: message.content, at };
			for (const [index, raw] of asArray(message?.content).entries()) {
				const block = asObject(raw);
				if (!block) continue;
				const key = `${messageId}:${asString(block.id) ?? `${index}:${block.type}`}`;
				if (seenBlocks.has(key)) continue;
				seenBlocks.add(key);
				if (block.type === "text")
					yield {
						type: "message",
						role: "assistant",
						text: asString(block.text) ?? "",
						at,
					};
				if (block.type === "thinking")
					yield { type: "thinking", text: asString(block.thinking) ?? "", at };
				if (block.type === "tool_use") {
					const name = asString(block.name) ?? "unknown_tool";
					const callId = asString(block.id);
					if (callId && name.toLowerCase() === "bash") shellCalls.add(callId);
					yield {
						type: "tool_call",
						callId,
						name,
						input: prettyInput(block.input),
						at,
					};
				}
			}
			continue;
		}
		if (record.type !== "user") continue;
		if (record.isCompactSummary === true) {
			yield { type: "compaction", text: toolResultText(message?.content), at };
			continue;
		}
		const content = message?.content;
		const human = humanPromptText(record);
		if (typeof content === "string")
			yield {
				type: "message",
				role: "user",
				text: content,
				at,
				injected: !human,
			};
		const texts: string[] = [];
		for (const raw of asArray(content)) {
			const block = asObject(raw);
			if (block?.type === "text") texts.push(asString(block.text) ?? "");
		}
		if (texts.length > 0)
			yield {
				type: "message",
				role: "user",
				text: texts.join("\n\n"),
				at,
				injected: !human,
			};
		for (const raw of asArray(content)) {
			const block = asObject(raw);
			if (block?.type === "image") {
				const source = asObject(block.source);
				const data = asString(source?.data);
				if (data)
					yield {
						type: "image",
						mimeType: asString(source?.media_type) ?? "image/png",
						base64: data,
						at,
					};
			}
			if (block?.type !== "tool_result") continue;
			const callId = asString(block.tool_use_id);
			const output = toolResultText(block.content);
			const isError = block.is_error === true;
			const result = asObject(record.toolUseResult);
			let exitCode = isError ? exitCodeFromText(output) : undefined;
			if (
				exitCode === undefined &&
				callId &&
				shellCalls.has(callId) &&
				block.is_error === false &&
				result
			) {
				if (
					result.returnCodeInterpretation === undefined &&
					result.interrupted !== true &&
					!result.backgroundTaskId
				)
					exitCode = 0;
			}
			yield { type: "tool_result", callId, output, isError, exitCode, at };
			for (const item of asArray(block.content)) {
				const source = asObject(asObject(item)?.source);
				const data = asString(source?.data);
				if (data)
					yield {
						type: "image",
						mimeType: asString(source?.media_type) ?? "image/png",
						base64: data,
						at,
					};
			}
		}
	}
}

function* codexItemEvents(
	item: JsonObject,
	at: string | undefined,
): Generator<TranscriptEvent> {
	const callId = asString(item.id);
	if (item.type === "CommandExecution") {
		const command =
			typeof item.command === "string"
				? item.command
				: commandFromArgv(asArray(item.command).map(String));
		const cwd = asString(item.cwd);
		yield {
			type: "tool_call",
			callId,
			name: "exec_command",
			input: cwd ? `${command}\n# cwd: ${fileUrlToPath(cwd)}` : command,
			at,
		};
		const exitCode = asNumber(item.exit_code);
		const output =
			asString(item.aggregated_output) ??
			asString(item.formatted_output) ??
			asString(item.stdout) ??
			"";
		yield {
			type: "tool_result",
			callId,
			output,
			exitCode,
			isError: item.status === "failed" || (exitCode ?? 0) !== 0,
			at,
		};
	} else if (item.type === "FileChange") {
		const changes = asObject(item.changes) ?? {};
		const diff = Object.entries(changes)
			.map(([file, raw]) => {
				const change = asObject(raw);
				return `*** ${asString(change?.type) ?? "update"} ${file}\n${asString(change?.unified_diff) ?? asString(change?.content) ?? ""}`;
			})
			.join("\n");
		yield { type: "tool_call", callId, name: "apply_patch", input: diff, at };
		const output = [asString(item.stdout), asString(item.stderr)]
			.filter(Boolean)
			.join("\n");
		yield {
			type: "tool_result",
			callId,
			output,
			isError: item.status !== "completed",
			at,
		};
	} else if (item.type === "McpToolCall") {
		const name =
			[asString(item.server), asString(item.tool)].filter(Boolean).join(".") ||
			"mcp_tool";
		yield {
			type: "tool_call",
			callId,
			name,
			input: prettyInput(item.arguments),
			at,
		};
		const result = asObject(item.result);
		for (const block of asArray(result?.content)) {
			const image = asObject(block);
			if (image?.type === "image" && typeof image.data === "string") {
				yield {
					type: "image",
					mimeType: asString(image.mimeType) ?? "image/png",
					base64: image.data,
					at,
				};
			}
		}
		yield {
			type: "tool_result",
			callId,
			output: parseCallOutput(result?.content ?? "").text,
			isError: item.status === "failed" || result?.isError === true,
			at,
		};
	} else if (item.type === "Extension") {
		yield {
			type: "tool_call",
			callId,
			name: asString(item.kind) ?? "extension",
			input: prettyInput({ query: item.query, action: item.action }),
			at,
		};
		yield {
			type: "tool_result",
			callId,
			output: stringifyValue(item.results),
			at,
		};
	}
}

function* codexEvents(
	ref: SessionRef,
	includeThinking: boolean,
): Generator<TranscriptEvent> {
	const itemMode = rolloutUsesItemEvents(ref.location);
	const seenCallIds = new Set<string>();
	const skippedCallIds = new Set<string>();
	const noise = [
		'"token_usage_record"',
		'"world_state"',
		'"type":"token_count"',
	];
	for (const line of linesForward(ref.location)) {
		const head = line.slice(0, 240);
		if (noise.some((type) => head.includes(type))) continue;
		if (!includeThinking && head.includes('"type":"reasoning"')) continue;
		const record = parseJsonObject(line);
		const unwrapped = record ? unwrapRecord(record) : undefined;
		if (!record || !unwrapped) continue;
		const { type, payload } = unwrapped;
		const at = asString(record.timestamp);
		if (type === "compacted") {
			const message = asString(payload.message);
			if (message?.trim()) yield { type: "compaction", text: message, at };
			continue;
		}
		if (type === "event_msg") {
			const item = asObject(payload.item);
			// Items that repeat a response call (same id) are already written.
			if (
				payload.type === "item_completed" &&
				item &&
				!seenCallIds.has(asString(item.id) ?? "")
			)
				yield* codexItemEvents(item, at);
			continue;
		}
		if (type !== "response_item") continue;
		if (payload.type === "message") {
			const text = messageText(payload);
			if (payload.role === "assistant")
				yield { type: "message", role: "assistant", text, at };
			if (payload.role === "user") {
				yield {
					type: "message",
					role: "user",
					text,
					at,
					injected: codexUserPromptText(text) === undefined,
				};
				for (const block of asArray(payload.content)) {
					const image = dataUrlImage(asString(asObject(block)?.image_url));
					if (image) yield { type: "image", ...image, at };
				}
			}
			continue;
		}
		if (payload.type === "reasoning") {
			const summary = asArray(payload.summary)
				.map((part) => asString(asObject(part)?.text) ?? "")
				.join("\n");
			yield { type: "thinking", text: summary, at };
			continue;
		}
		const callId = asString(payload.call_id);
		if (itemMode && isCodeModeWrapper(payload)) {
			if (callId) skippedCallIds.add(callId);
			continue;
		}
		if (callId && skippedCallIds.has(callId)) continue;
		if (callId) seenCallIds.add(callId);
		if (payload.type === "function_call") {
			yield {
				type: "tool_call",
				callId,
				name: asString(payload.name) ?? "unknown_tool",
				input: prettyInput(payload.arguments),
				at,
			};
		} else if (payload.type === "custom_tool_call") {
			yield {
				type: "tool_call",
				callId,
				name: asString(payload.name) ?? "unknown_tool",
				input: asString(payload.input) ?? "",
				at,
			};
		} else if (payload.type === "local_shell_call") {
			yield {
				type: "tool_call",
				callId,
				name: "local_shell",
				input: prettyInput(payload.action),
				at,
			};
		} else if (
			payload.type === "function_call_output" ||
			payload.type === "custom_tool_call_output"
		) {
			const output = parseCallOutput(payload.output);
			for (const block of asArray(payload.output)) {
				const image = dataUrlImage(asString(asObject(block)?.image_url));
				if (image) yield { type: "image", ...image, at };
			}
			const isError =
				output.success === undefined
					? (output.exitCode ?? 0) !== 0
					: !output.success;
			yield {
				type: "tool_result",
				callId,
				output: output.text,
				exitCode: output.exitCode,
				isError,
				at,
			};
		}
	}
}

function* opencodeMessageEvents(
	message: OpencodeMessage,
): Generator<TranscriptEvent> {
	const at = message.createdAt
		? new Date(message.createdAt).toISOString()
		: undefined;
	const role =
		message.data.role === "user"
			? "user"
			: message.data.role === "assistant"
				? "assistant"
				: undefined;
	if (!role) return;
	if (role === "assistant" && message.data.summary === true) {
		const text = message.parts
			.filter((part) => part.type === "text")
			.map((part) => asString(part.text) ?? "");
		yield { type: "compaction", text: text.join("\n"), at };
		return;
	}
	for (const part of message.parts) {
		if (part.type === "text")
			yield {
				type: "message",
				role,
				text: asString(part.text) ?? "",
				at,
				injected: part.synthetic === true,
			};
		if (part.type === "reasoning")
			yield { type: "thinking", text: asString(part.text) ?? "", at };
		if (part.type === "file") {
			const image = dataUrlImage(asString(part.url));
			if (image)
				yield {
					type: "image",
					mimeType: asString(part.mime) ?? image.mimeType,
					base64: image.base64,
					at,
				};
		}
		if (part.type === "tool") {
			const state = asObject(part.state) ?? {};
			const callId = asString(part.callID);
			yield {
				type: "tool_call",
				callId,
				name: asString(part.tool) ?? "unknown_tool",
				input: prettyInput(state.input),
				at,
			};
			const exitCode = asNumber(asObject(state.metadata)?.exit);
			const isError =
				state.status === "error" || (exitCode !== undefined && exitCode !== 0);
			yield {
				type: "tool_result",
				callId,
				output: stringifyValue(state.output ?? state.error),
				exitCode,
				isError,
				at,
			};
		}
	}
}

function* opencodeEvents(
	ref: SessionRef,
	home: string,
): Generator<TranscriptEvent> {
	if (ref.location.endsWith(".json")) {
		for (const message of legacyMessages(home, ref.id))
			yield* opencodeMessageEvents(message);
		return;
	}
	const database = openOpencodeDatabase(ref.location);
	if (!database) return;
	try {
		for (const message of databaseMessages(database, ref.id, false))
			yield* opencodeMessageEvents(message);
	} finally {
		database.close();
	}
}

function* piEvents(ref: SessionRef): Generator<TranscriptEvent> {
	const entries: JsonObject[] = [];
	for (const line of linesForward(ref.location)) {
		const record = parseJsonObject(line);
		if (record && (record.type === "message" || record.type === "compaction"))
			entries.push(record);
	}
	for (const entry of piBranchEntries(entries)) {
		const at = asString(entry.timestamp);
		if (entry.type === "compaction") {
			yield { type: "compaction", text: asString(entry.summary) ?? "", at };
			continue;
		}
		const message = asObject(entry.message);
		const role = asString(message?.role);
		const content = message?.content;
		const images = asArray(content)
			.map((block) => asObject(block))
			.filter(
				(block) => block?.type === "image" && typeof block.data === "string",
			);
		if (role === "user" || role === "assistant") {
			for (const raw of asArray(content)) {
				const block = asObject(raw);
				if (block?.type === "text")
					yield { type: "message", role, text: asString(block.text) ?? "", at };
				if (block?.type === "thinking")
					yield { type: "thinking", text: asString(block.thinking) ?? "", at };
				if (block?.type === "toolCall") {
					yield {
						type: "tool_call",
						callId: asString(block.id),
						name: asString(block.name) ?? "unknown_tool",
						input: prettyInput(block.arguments),
						at,
					};
				}
			}
			if (typeof content === "string")
				yield { type: "message", role, text: content, at };
		} else if (role === "toolResult") {
			const output = textBlocks(content);
			const isError = message?.isError === true;
			const exitCode = isError ? exitCodeFromText(output) : undefined;
			yield {
				type: "tool_result",
				callId: asString(message?.toolCallId),
				output,
				isError,
				exitCode,
				at,
			};
		} else if (role === "bashExecution") {
			yield {
				type: "tool_call",
				name: "bash (user)",
				input: asString(message?.command) ?? "",
				at,
			};
			yield {
				type: "tool_result",
				output: stringifyValue(message?.output),
				exitCode: asNumber(message?.exitCode),
				at,
			};
		}
		for (const image of images) {
			yield {
				type: "image",
				mimeType: asString(image?.mimeType) ?? "image/png",
				base64: image?.data as string,
				at,
			};
		}
	}
}

function* grokEvents(ref: SessionRef): Generator<TranscriptEvent> {
	const updatesFile = path.join(ref.location, "updates.jsonl");
	let chunks = "";
	let chunkRole: "user" | "assistant" | "thinking" | undefined;
	let chunkAt: string | undefined;
	function* flush(): Generator<TranscriptEvent> {
		const role = chunkRole;
		if (chunks && role === "thinking")
			yield { type: "thinking", text: chunks, at: chunkAt };
		else if (chunks && (role === "user" || role === "assistant"))
			yield {
				type: "message",
				role,
				text: role === "user" ? extractUserQuery(chunks) : chunks,
				at: chunkAt,
			};
		chunks = "";
		chunkRole = undefined;
		chunkAt = undefined;
	}
	for (const line of linesForward(updatesFile)) {
		if (
			!line.includes("_chunk") &&
			!line.includes('"tool_call') &&
			!line.includes('"session_recap"')
		)
			continue;
		const record = parseJsonObject(line);
		const update = record ? updateOf(record) : undefined;
		if (!record || !update) continue;
		const at = asString(record.timestamp);
		const kind = asString(update.sessionUpdate);
		const chunkKind =
			kind === "user_message_chunk"
				? "user"
				: kind === "agent_message_chunk"
					? "assistant"
					: kind === "agent_thought_chunk"
						? "thinking"
						: undefined;
		if (chunkKind) {
			const content = asObject(update.content);
			if (content?.type === "image" && typeof content.data === "string") {
				yield* flush();
				yield {
					type: "image",
					mimeType: asString(content.mimeType) ?? "image/png",
					base64: content.data,
					at,
				};
				continue;
			}
			if (chunkRole !== chunkKind) yield* flush();
			chunkRole = chunkKind;
			chunkAt ??= at;
			chunks += asString(content?.text) ?? "";
			continue;
		}
		yield* flush();
		if (kind === "session_recap")
			yield { type: "compaction", text: asString(update.summary) ?? "", at };
		if (kind === "tool_call") {
			const meta = asObject(asObject(update._meta)?.["x.ai/tool"]);
			const name =
				asString(meta?.name) ?? asString(update.title) ?? "unknown_tool";
			yield {
				type: "tool_call",
				callId: asString(update.toolCallId),
				name,
				input: prettyInput(update.rawInput),
				at,
			};
		}
		if (
			kind === "tool_call_update" &&
			(update.status === "completed" || update.status === "failed")
		) {
			const callId = asString(update.toolCallId);
			const texts = asArray(update.content)
				.map((item) => asString(asObject(asObject(item)?.content)?.text))
				.filter((text): text is string => !!text);
			const raw = asObject(update.rawOutput);
			const output =
				texts.join("\n") ||
				(typeof update.rawOutput === "string"
					? update.rawOutput
					: stringifyValue(raw?.output ?? raw));
			const exitCode = asNumber(raw?.exit_code);
			yield {
				type: "tool_result",
				callId,
				output,
				exitCode,
				isError: update.status === "failed" || (exitCode ?? 0) !== 0,
				at,
			};
		}
	}
	yield* flush();
}

/** Gemini and Cursor readers already produce events; inputs are written untruncated. */
function* sharedEvents(events: SessionEvent[]): Generator<TranscriptEvent> {
	for (const event of events) {
		if (event.type === "tool_call") {
			yield {
				type: "tool_call",
				callId: event.callId,
				name: event.name,
				input:
					typeof event.input === "string"
						? event.input
						: JSON.stringify(event.input ?? {}),
				at: event.at,
			};
		} else if (event.type === "tool_result") {
			yield {
				type: "tool_result",
				callId: event.callId,
				output: event.output,
				isError: event.isError,
				exitCode: event.exitCode,
				at: event.at,
			};
		} else {
			yield event;
		}
	}
}

function readerEvents(ref: SessionRef): SessionEvent[] {
	if (ref.tool === "gemini") return parseGeminiSession(ref).events;
	if (ref.tool === "cursor-agent")
		return cursorAgentConversation(ref.location).events;
	return cursorComposerConversation(ref.location, ref.id).events;
}

function sessionHeader(ref: SessionRef): string[] {
	const lines = [`# ${ref.tool} session ${ref.id}`, "", `- cwd: ${ref.cwd}`];
	if (ref.tool === "codex") {
		const meta = readCodexSessionMeta(ref.location);
		if (meta?.gitBranch) lines.push(`- git branch: ${meta.gitBranch}`);
		if (meta?.cliVersion) lines.push(`- cli version: ${meta.cliVersion}`);
		if (meta?.startedAt) lines.push(`- started: ${meta.startedAt}`);
	}
	if (ref.tool === "pi") {
		const header = readPiHeader(ref.location);
		if (header?.timestamp) lines.push(`- started: ${header.timestamp}`);
	}
	if (ref.tool === "grok") {
		const summary = readSummary(ref.location);
		const model = asString(summary?.current_model_id);
		if (model) lines.push(`- model: ${model}`);
	}
	lines.push(`- updated: ${new Date(ref.updatedAt).toISOString()}`);
	return lines;
}

/** Writes the full transcript of `ref` as Markdown plus image files; see the module comment. */
export function exportFullTranscript(
	ref: SessionRef,
	options: FullTranscriptOptions,
): FullTranscriptResult {
	const home = options.home ?? os.homedir();
	const includeThinking = options.includeThinking === true;
	const imagesDirectory =
		options.imagesDirectory ??
		path.join(
			path.dirname(options.outputFile),
			`${path.basename(options.outputFile, path.extname(options.outputFile))}-images`,
		);
	const writer = new MarkdownTranscriptWriter(options, imagesDirectory);
	try {
		writer.header(sessionHeader(ref));
		const events = (() => {
			switch (ref.tool) {
				case "claude":
					return claudeEvents(ref);
				case "codex":
					return codexEvents(ref, includeThinking);
				case "opencode":
					return opencodeEvents(ref, home);
				case "pi":
					return piEvents(ref);
				case "grok":
					return grokEvents(ref);
				case "gemini":
				case "cursor-agent":
				case "cursor":
					return sharedEvents(readerEvents(ref));
			}
		})();
		for (const event of events) writer.event(event);
	} finally {
		writer.close();
	}
	return {
		transcriptFile: options.outputFile,
		images: writer.images,
		bytesWritten: writer.bytesWritten,
		sections: writer.sections,
		toolCalls: writer.toolCalls,
	};
}
