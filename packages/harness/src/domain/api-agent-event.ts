import type { ApiTokenUsage } from "./api-token-usage";
import type { CodexUsage } from "./codex-usage";

export type ApiAgentEvent =
	| { type: "context"; compacting: boolean; context?: CodexUsage["context"] }
	| { type: "usage"; usage: ApiTokenUsage }
	| { type: "text-delta"; id: string; text: string }
	| { type: "reasoning-delta"; id: string; text: string }
	| { type: "reasoning-end"; id: string; durationSeconds: number }
	/** Partial output of a model response that dropped and is being sampled again. */
	| { type: "retract"; ids: string[] }
	| { type: "tool-call"; id: string; name: string; input: unknown }
	| {
			type: "tool-result";
			id: string;
			name: string;
			output: unknown;
			failed?: boolean;
	  }
	| {
			type: "finish";
			inputTokens: number | null;
			outputTokens: number | null;
			reason: string;
	  };
