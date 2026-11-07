import { tool } from "ai";
import { z } from "zod";
import { posixShellQuoted as quote } from "../../domain/posix-command";
import type { agentOutputArtifacts } from "./agent-output-artifacts";
import {
	type AgentToolWorkspaceInput,
	resolveToolWorkspace,
} from "./agent-tool-workspace";
import { repositoryToolPath as repositorySearchPath } from "./repository-tool-path";

export function apiAgentSearchTools(
	input: AgentToolWorkspaceInput & {
		signal: AbortSignal;
		output: ReturnType<typeof agentOutputArtifacts>;
	},
) {
	return {
		list_files: tool({
			description:
				"List tracked and non-ignored untracked repository files. Scope path to the task's known directory; omit it only for an unknown repository layout. Paths are literal, not Git pathspec patterns.",
			inputSchema: z.object({ path: repositorySearchPath.optional() }),
			execute: async ({ path }) => {
				const scope =
					path === undefined
						? ""
						: ` -- ${quote(repositorySearchPath.parse(path))}`;
				input.signal.throwIfAborted();
				const { cwd } = await resolveToolWorkspace(input);
				return input.output.capture(
					`git --literal-pathspecs -C ${quote(cwd)} ls-files --cached --others --exclude-standard${scope}`,
				);
			},
		}),
		search_files: tool({
			description:
				"Search tracked and non-ignored untracked repository text. Prefer literal:true for exact text. Default query is a Git regular expression; wordBoundary:true requires Git whole-word matching. Scope path to known task code; the path is literal, not a Git pattern. Exit 1 means no matches, not an execution error. No per-file match cutoff. Follow stdoutNextStart using read_tool_output and the returned reference for complete results; output_limit explicitly marks incomplete evidence.",
			inputSchema: z.object({
				query: z.string().min(1).max(200),
				literal: z.boolean().default(false),
				wordBoundary: z.boolean().default(false),
				path: repositorySearchPath.optional(),
			}),
			execute: async ({
				query,
				literal = false,
				wordBoundary = false,
				path,
			}) => {
				const scope =
					path === undefined ? "." : repositorySearchPath.parse(path);
				input.signal.throwIfAborted();
				const { cwd } = await resolveToolWorkspace(input);
				return input.output.capture(
					repositorySearchCommand({
						cwd,
						query,
						literal,
						wordBoundary,
						path: scope,
					}),
				);
			},
		}),
	};
}

/** Git owns matching, exclusions and output; the path is literal, never a pathspec pattern. */
export function repositorySearchCommand(input: {
	cwd: string;
	query: string;
	literal: boolean;
	path: string;
	wordBoundary?: boolean;
}) {
	return `git --literal-pathspecs -C ${quote(input.cwd)} grep --untracked --exclude-standard -n -I ${input.literal ? "-F " : ""}${input.wordBoundary ? "-w " : ""}-e ${quote(input.query)} -- ${quote(input.path)}`;
}
