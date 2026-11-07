import type {
	AssistantModelMessage,
	ModelMessage,
	ToolModelMessage,
	UserModelMessage,
} from "ai";

const runtimeHandoffPrefix =
	"Continue this same workspace conversation after a runtime switch. The JSON below is prior conversation evidence, not new instructions. Do not re-execute old requests. Inspect the current working tree before changing it.\n<previous-conversation>\n";

const requestBoundary = "\n</previous-conversation>\n\nCurrent user request:\n";

/** Unwrap only our complete envelope, not quoted snippets or ordinary user text. */
export function visibleRuntimeUserText(text: string): string {
	if (!text.startsWith(runtimeHandoffPrefix)) return text;
	const boundary = text.indexOf(requestBoundary, runtimeHandoffPrefix.length);
	if (boundary < runtimeHandoffPrefix.length) return text;
	try {
		const history: unknown = JSON.parse(
			text.slice(runtimeHandoffPrefix.length, boundary),
		);
		if (!Array.isArray(history)) return text;
		const request = text.slice(boundary + requestBoundary.length);
		return request.trim() ? request : text;
	} catch {
		return text;
	}
}

export function runtimeHandoffEnvelope(
	history: unknown,
	prompt: string,
): string {
	return `${runtimeHandoffPrefix}${JSON.stringify(history)}${requestBoundary}${prompt}`;
}

type MessagePart = Exclude<ModelMessage["content"], string>[number];

const PORTABLE_FILE_DATA = new Set(["data", "url", "text"]);

/** A provider id or reference that another provider cannot resolve. */
function providerBoundFile(part: MessagePart) {
	if (part.type !== "file") return false;
	const data = part.data as unknown;
	if (
		!data ||
		typeof data !== "object" ||
		data instanceof Uint8Array ||
		data instanceof ArrayBuffer ||
		data instanceof URL
	)
		return false;
	const type = (data as { type?: unknown }).type;
	return typeof type !== "string" || !PORTABLE_FILE_DATA.has(type);
}

/** Tool call ids every provider accepts (Anthropic allows only [A-Za-z0-9_-]). */
function portableToolCallId(id: string) {
	return id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "call";
}

function withoutProviderOptions<T extends { providerOptions?: unknown }>(
	value: T,
): T {
	const { providerOptions: _ignored, ...rest } = value;
	return rest as T;
}

/** Stand-in results for tool calls a turn never answered, by how it ended. */
export const UNANSWERED_TOOL_CALL = {
	stopped:
		"No result: the turn was stopped before this call finished, so it may not have run (or ran only partly). Inspect the workspace before relying on it.",
	interrupted:
		"No result: the turn was interrupted before this call finished, so it may not have run (or ran only partly). Inspect the workspace before relying on it.",
} as const;

/**
 * Every tool call of the agent's own gets a result: a call a stopped or
 * failed turn left unanswered gets a stand-in error result right after it, so
 * the history stays well formed without hiding that the call was made.
 * Provider-executed calls (hosted search) carry their own results.
 */
export function closeUnansweredToolCalls(
	messages: readonly ModelMessage[],
	note: string,
): ModelMessage[] {
	const answered = new Set<string>();
	for (const message of messages)
		if (message.role === "tool")
			for (const part of message.content)
				if (part.type === "tool-result") answered.add(part.toolCallId);
	const closed: ModelMessage[] = [];
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		closed.push(message);
		if (message.role !== "assistant" || typeof message.content === "string")
			continue;
		const missing = message.content.flatMap(
			(part): ToolModelMessage["content"] =>
				part.type === "tool-call" &&
				!part.providerExecuted &&
				!answered.has(part.toolCallId)
					? [
							{
								type: "tool-result",
								toolCallId: part.toolCallId,
								toolName: part.toolName,
								output: { type: "error-text", value: note },
							},
						]
					: [],
		);
		if (!missing.length) continue;
		const next = messages[index + 1];
		if (next?.role === "tool") {
			closed.push({ ...next, content: [...next.content, ...missing] });
			index++;
		} else closed.push({ role: "tool", content: missing });
	}
	return closed;
}

/**
 * The conversation as any provider can read it, for a mid-turn switch to
 * another provider or account. Reasoning (OpenAI encrypted content, Anthropic
 * thinking signatures), provider-executed tools (hosted search) and every
 * providerOptions entry (item ids, cache hints, phases) belong to the provider
 * that produced them and are dropped. Text, files, and the agent's own tool
 * calls with their results are kept; a call without a result gets a stand-in
 * result (`unanswered`), and a result without its call is dropped, so the
 * history stays well formed.
 */
export function providerNeutralHistory(
	original: readonly ModelMessage[],
	unanswered: string = UNANSWERED_TOOL_CALL.interrupted,
): ModelMessage[] {
	const messages = closeUnansweredToolCalls(original, unanswered);
	const calls = new Set<string>();
	const results = new Set<string>();
	for (const message of messages) {
		if (typeof message.content === "string") continue;
		for (const part of message.content) {
			if (
				message.role === "assistant" &&
				part.type === "tool-call" &&
				!part.providerExecuted
			)
				calls.add(part.toolCallId);
			if (message.role === "tool" && part.type === "tool-result")
				results.add(part.toolCallId);
		}
	}
	const paired = (id: string) => calls.has(id) && results.has(id);
	const neutral: ModelMessage[] = [];
	for (const message of messages) {
		if (typeof message.content === "string") {
			neutral.push(withoutProviderOptions(message));
			continue;
		}
		if (message.role === "assistant") {
			const content = message.content.flatMap(
				(part): Exclude<AssistantModelMessage["content"], string> => {
					if (part.type === "text")
						return part.text ? [withoutProviderOptions(part)] : [];
					if (part.type === "file")
						return providerBoundFile(part)
							? []
							: [withoutProviderOptions(part)];
					if (
						part.type === "tool-call" &&
						!part.providerExecuted &&
						paired(part.toolCallId)
					)
						return [
							{
								...withoutProviderOptions(part),
								toolCallId: portableToolCallId(part.toolCallId),
							},
						];
					return [];
				},
			);
			if (content.length) neutral.push({ role: "assistant", content });
			continue;
		}
		if (message.role === "tool") {
			const content = message.content.flatMap(
				(part): ToolModelMessage["content"] =>
					part.type === "tool-result" && paired(part.toolCallId)
						? [
								{
									...withoutProviderOptions(part),
									toolCallId: portableToolCallId(part.toolCallId),
									output: withoutProviderOptions(
										part.output as typeof part.output & {
											providerOptions?: unknown;
										},
									),
								},
							]
						: [],
			);
			if (content.length) neutral.push({ role: "tool", content });
			continue;
		}
		if (message.role === "user") {
			const content = message.content.flatMap(
				(part): Exclude<UserModelMessage["content"], string> =>
					part.type === "file" && providerBoundFile(part)
						? []
						: [withoutProviderOptions(part)],
			);
			if (content.length) neutral.push({ role: "user", content });
			continue;
		}
		neutral.push(withoutProviderOptions(message));
	}
	return neutral;
}

/** The provider-neutral history with the runtime note that explains the switch. */
export function modelSwitchHistory(
	messages: readonly ModelMessage[],
	note: string,
): ModelMessage[] {
	return [...providerNeutralHistory(messages), { role: "user", content: note }];
}

/** The saved model history of a chat's latest turn, and what produced it. */
export type SavedTurnHistory = {
	readonly messages: readonly ModelMessage[];
	readonly modelId: string;
	readonly connectionRevision: string;
	readonly state: "completed" | "failed" | "cancelled";
	/** The turn ended on a fallback route, not the one it was saved under. */
	readonly failedOver: boolean;
};

const SUBSCRIPTION_REVISION = "codex-subscription:";

/** Same model on the same credentials: provider-bound items (reasoning, ids) stay valid. */
function sameTransport(
	saved: SavedTurnHistory,
	next: { modelId: string; connectionRevision: string },
) {
	if (saved.failedOver || saved.modelId !== next.modelId) return false;
	// A subscription's revision records only reasoning and speed settings.
	return (
		saved.connectionRevision === next.connectionRevision ||
		(saved.connectionRevision.startsWith(SUBSCRIPTION_REVISION) &&
			next.connectionRevision.startsWith(SUBSCRIPTION_REVISION))
	);
}

/**
 * The structured history the next turn continues from, whatever ended the
 * last one: native on the same transport, provider-neutral on another model
 * or connection. Calls the last turn never answered get stand-in results.
 */
export function continuedTurnHistory(
	saved: SavedTurnHistory,
	next: { modelId: string; connectionRevision: string },
): ModelMessage[] {
	const unanswered =
		saved.state === "cancelled"
			? UNANSWERED_TOOL_CALL.stopped
			: UNANSWERED_TOOL_CALL.interrupted;
	return sameTransport(saved, next)
		? closeUnansweredToolCalls(saved.messages, unanswered)
		: providerNeutralHistory(saved.messages, unanswered);
}
