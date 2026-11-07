import { type ToolSet, tool } from "ai";
import { z } from "zod";
import {
	type AgentToolWorkspaceInput,
	resolveToolWorkspace,
} from "./agent-tool-workspace";
import { runGuestCapability } from "./guest-node-capability";
import {
	LANGUAGE_INTELLIGENCE_SOURCE,
	languageQuery,
	languageQueryResult,
} from "./language-intelligence";
import { editLanguage } from "./warm-edit-diagnostics";

export function apiAgentLanguageTools(
	input: AgentToolWorkspaceInput & { signal: AbortSignal },
): ToolSet {
	const batch = z.object({ requests: z.array(languageQuery).min(2).max(4) });
	return {
		inspect_code_batch: tool({
			description:
				"Run two to four independent read-only language queries for the same language/project in one VM execution and one warm-server connection. Supports definitions, references, hover, diagnostics, code actions and rename previews. Does not apply edits. All requests must target the same language; use separate batches for TS and JS. Avoid batching requests that depend on each other's result.",
			inputSchema: batch,
			execute: async (args) => {
				const { requests } = batch.parse(args);
				const language = editLanguage(requests[0].path);
				if (
					!language ||
					requests.some((request) => editLanguage(request.path) !== language)
				)
					throw new Error(
						"Batch requires one supported language; no queries started.",
					);
				const workspace = await resolveToolWorkspace(input);
				return runGuestCapability(
					workspace,
					"language",
					LANGUAGE_INTELLIGENCE_SOURCE,
					{ path: requests[0].path, requests, cwd: workspace.cwd },
					z.object({ results: z.array(languageQueryResult).min(2).max(4) }),
					input.signal,
				);
			},
		}),
		inspect_code: tool({
			description:
				"Use a language server in the task VM for definitions, references, hover/type information, observed diagnostics, a rename preview, or code_actions. Code-action selections use line/column and optional endLine/endColumn plus kind; returned index and sha256 fence apply_code_action. Read-only: no edits are applied. Positions are 1-based UTF-16. TypeScript/JavaScript have pinned tooling; Python/Rust/Go require their language-server binary in the VM. Diagnostics are observations, not proof a full typecheck passed.",
			inputSchema: languageQuery,
			execute: async (args) => {
				const workspace = await resolveToolWorkspace(input);
				return runGuestCapability(
					workspace,
					"language",
					LANGUAGE_INTELLIGENCE_SOURCE,
					{ ...args, cwd: workspace.cwd },
					languageQueryResult,
					input.signal,
				);
			},
		}),
	};
}
