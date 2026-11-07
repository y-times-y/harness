import { z } from "zod";
import type { AgentToolWorkspace } from "./agent-tool-workspace";
import { runGuestCapability } from "./guest-node-capability";
import {
	LANGUAGE_INTELLIGENCE_SOURCE,
	languageQueryResult,
} from "./language-intelligence";

const feedback = z.union([
	z.object({ available: z.literal(false) }),
	languageQueryResult.extend({ available: z.literal(true) }),
	z.object({ available: z.literal(true), closed: z.literal(true) }),
]);

export function editLanguage(path: string) {
	if (/\.[cm]?tsx?$/.test(path)) return "typescript";
	if (/\.[cm]?jsx?$/.test(path)) return "javascript";
	if (/\.py$/.test(path)) return "python";
	if (/\.rs$/.test(path)) return "rust";
	if (/\.go$/.test(path)) return "go";
	return null;
}

export async function warmEditDiagnostics(
	workspace: AgentToolWorkspace,
	edit: { path: string; deleted?: boolean; previousPath?: string },
	signal: AbortSignal,
) {
	if (!editLanguage(edit.path)) return undefined;
	try {
		return await runGuestCapability(
			workspace,
			"language",
			LANGUAGE_INTELLIGENCE_SOURCE,
			{
				...edit,
				cwd: workspace.cwd,
				operation: "diagnostics",
				line: 1,
				column: 1,
				onlyIfWarm: true,
				diagnosticWaitMs: 0,
			},
			feedback,
			signal,
			{ onlyInstalled: true },
		);
	} catch {
		// A successful edit must remain a successful receipt even if feedback fails.
		return {
			available: false,
			reason:
				"Language feedback unavailable; run project checks before completion.",
		};
	}
}
