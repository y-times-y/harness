/**
 * Event stream shared by the Gemini and Cursor readers: each reader turns its store
 * into these events once, and both the normalized session (readSession) and the full
 * Markdown export are built from them, so the two never disagree.
 */
import { createToolCall, setToolOutput } from "./tool-calls.ts";
import { TurnAssembler } from "./transcript.ts";
import type { ToolCall, ToolCallKind, Turn } from "./types.ts";

export type SessionEvent =
	| { type: "message"; role: "user" | "assistant"; text: string; at?: string }
	| { type: "thinking"; text: string; at?: string }
	| { type: "compaction"; text: string; at?: string }
	| {
			type: "tool_call";
			callId?: string;
			name: string;
			/** Raw input: an object, JSON text or patch text. */
			input: unknown;
			kind?: ToolCallKind;
			/** Shell command line when the input does not name it as `command` / `cmd`. */
			command?: string;
			at?: string;
	  }
	| {
			type: "tool_result";
			callId?: string;
			output: string;
			isError?: boolean;
			exitCode?: number;
			/** Files the call changed, when the source records them apart from the input. */
			changedPaths?: string[];
			at?: string;
	  };

/** Builds normalized turns; results attach by call id, else to the newest call without one. */
export function turnsFromEvents(
	events: Iterable<SessionEvent>,
	activityOnly = false,
): Turn[] {
	const assembler = new TurnAssembler(activityOnly);
	const pending: ToolCall[] = [];
	for (const event of events) {
		switch (event.type) {
			case "message":
				if (event.role === "user") assembler.addUserText(event.text, event.at);
				else assembler.addAssistantText(event.text, event.at);
				break;
			case "compaction":
				assembler.addCompactionSummary(event.text, event.at);
				break;
			case "thinking":
				break;
			case "tool_call": {
				const call = createToolCall({
					name: event.name,
					input: event.input ?? {},
					kind: event.kind,
				});
				if (event.command) call.command = event.command;
				assembler.addToolCall(call, event.callId, event.at);
				pending.push(call);
				break;
			}
			case "tool_result": {
				const call =
					assembler.toolCall(event.callId) ??
					(event.callId === undefined ? pending.at(-1) : undefined);
				if (!call) break;
				const index = pending.indexOf(call);
				if (index !== -1) pending.splice(index, 1);
				setToolOutput(call, event.output);
				if (event.exitCode !== undefined) call.exitCode = event.exitCode;
				if (event.isError !== undefined) call.isError = event.isError;
				for (const file of event.changedPaths ?? [])
					if (!call.changedPaths.includes(file)) call.changedPaths.push(file);
				assembler.resultApplied(call);
				break;
			}
		}
	}
	return assembler.finish();
}

/** First non-empty user message text, for titles. */
export function firstUserText(events: SessionEvent[]): string | undefined {
	for (const event of events)
		if (event.type === "message" && event.role === "user" && event.text.trim())
			return event.text.trim();
	return undefined;
}
