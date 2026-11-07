import type { ToolSet } from "ai";
import { agentOutputArtifacts } from "../server/services/agent-output-artifacts";
import type { AgentToolWorkspace } from "../server/services/agent-tool-workspace";
import { apiAgentCommandTools } from "../server/services/api-agent-command-tools";
import { apiAgentFileTools } from "../server/services/api-agent-file-tools";
import { apiAgentImageTools } from "../server/services/api-agent-image-tools";
import { apiAgentLanguageTools } from "../server/services/api-agent-language-tools";
import { apiAgentSearchTools } from "../server/services/api-agent-search-tools";
import { batchedAgentReads } from "../server/services/batched-agent-reads";
import { codeToolingTools } from "../server/services/code-tooling";
import { dapDebuggerTools } from "../server/services/dap-debugger";
import { nodeDebuggerTools } from "../server/services/node-debugger";
import { repositoryGuidanceTool } from "../server/services/repository-guidance";

export type BuilderWorkspace<M extends AgentToolWorkspace["machines"]> =
	AgentToolWorkspace<M> & {
		signal: AbortSignal;
		sessionId: string;
		turnId: string;
	};

/** In-memory write-once receipts: each tool call id runs once. */
export function memoryReceipts() {
	const receipts = new Map<string, Promise<unknown>>();
	return (id: string, run: () => Promise<unknown>) => {
		let receipt = receipts.get(id);
		if (!receipt) {
			receipt = run();
			receipts.set(id, receipt);
		}
		return receipt;
	};
}

/**
 * The product's base tool set (file, search, language, image, command,
 * debugger and code-tooling tools) over a workspace. A ChatGPT plan route
 * gets freeform apply_patch; an official OpenAI endpoint the native one.
 * `readOnly` is a read-only helper's set: read-only file tools but a working
 * command runner.
 */
export function builderBaseTools<M extends AgentToolWorkspace["machines"]>(
	workspace: BuilderWorkspace<M>,
	options: { nativePatch: boolean; freeformPatch: boolean; readOnly?: boolean },
): ToolSet {
	const execution = {
		...workspace,
		ownerSessionId: workspace.sessionId,
		readOnly: false,
		once: memoryReceipts(),
	};
	const output = agentOutputArtifacts(execution);
	const tools: ToolSet = {
		...apiAgentFileTools({
			...execution,
			readOnly: options.readOnly ?? false,
			output,
			nativePatch: options.nativePatch,
			freeformPatch: options.freeformPatch,
		}),
		...apiAgentSearchTools({ ...execution, output }),
		...apiAgentLanguageTools(execution),
		...apiAgentImageTools(execution),
		...apiAgentCommandTools({ ...execution, output }),
		...nodeDebuggerTools(execution),
		...dapDebuggerTools(execution),
		...codeToolingTools(execution),
		read_tool_output: output.readTool,
		read_repository_guidance: repositoryGuidanceTool(execution),
	};
	tools.batch_read = batchedAgentReads(tools, workspace.signal);
	return tools;
}
