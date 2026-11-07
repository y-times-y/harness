import type { ModelMessage, ToolSet } from "ai";
import type { ApiAgentEvent } from "../domain/api-agent-event";
import { CODE_MODE_TOOL } from "../domain/code-mode";
import type { HarnessVariant } from "../domain/harness-variant";
import type { ModelProvider } from "../domain/model-connection";
import { UNATTENDED_RUN_INSTRUCTIONS } from "../domain/rigor";
import type { ContextArchiveStorage } from "../server/providers/context-archive-store";
import { archiveModelContext } from "../server/providers/context-archive-store";
import { nativeWebSearchTools } from "../server/providers/native-web-search";
import { nodePublicHost } from "../server/providers/public-host";
import { agentContextArchiveTools } from "../server/services/agent-context-archive-tools";
import type { AgentToolWorkspace } from "../server/services/agent-tool-workspace";
import { agentTurnInstructions } from "../server/services/agent-turn-instructions";
import { automaticRepositoryContext } from "../server/services/automatic-repository-context";
import { builderToolSurface } from "../server/services/builder-shell-surface";
import {
	codeModeTool,
	memoryCodeModeJournal,
	primaryCodeModeTools,
} from "../server/services/code-mode-tool";
import { compactionStateSnapshot } from "../server/services/compaction-state-snapshot";
import type { ModelAgentInput } from "../server/services/model-agent-loop";
import { type PlanUpdate, planTool } from "../server/services/plan-tool";
import { webFetchTool } from "../server/services/web-fetch-tool";
import {
	type BuilderWorkspace,
	builderBaseTools,
	memoryReceipts,
} from "./builder-tools";

function memoryMemo() {
	const values = new Map<string, Promise<unknown>>();
	return <T>(key: string, load: () => Promise<T>) => {
		let value = values.get(key) as Promise<T> | undefined;
		if (!value) {
			value = load();
			values.set(key, value);
		}
		return value;
	};
}

export type ProductHarness = {
	tools: ToolSet;
	instructions: string;
	/** ModelAgentInput hooks: repository context, archives, compaction snapshot. */
	input: Pick<
		ModelAgentInput,
		| "prepareMessages"
		| "afterTools"
		| "restoreInstructions"
		| "archiveHistory"
		| "compactionSnapshot"
		| "isUserRequest"
	>;
	/** The tool-name family the lean surface uses (codex, claude, gemini or core). */
	leanShape: string | null;
};

/**
 * The tools, instructions and context hooks of the ytimesy root builder on
 * one machine: the lean tool surface for the model's family, code mode,
 * web fetch and search, the plan tool, and repository instructions. This is
 * the configuration unattended runs use
 * for a single agent; delegation to other
 * agents and the review loop need the cloud product's job stack.
 */
export async function productHarness(input: {
	workspace: BuilderWorkspace<AgentToolWorkspace["machines"]>;
	userId: string;
	modelId: string;
	provider: ModelProvider;
	variant: HarnessVariant;
	/** The provider's hosted web search tool. */
	webSearch: boolean;
	/** The user's task: it survives context compaction verbatim. */
	instruction: string;
	storage: ContextArchiveStorage;
	/** Puts the workspace commands (ytimesy-job, ytimesy-check, ...) on the machine. */
	installHelpers: (workspace: AgentToolWorkspace) => Promise<void>;
	onEvent: (event: ApiAgentEvent) => Promise<void>;
	onPlanUpdate?: (update: PlanUpdate) => void;
}): Promise<ProductHarness> {
	const { workspace, variant } = input;
	const memo = memoryMemo();
	const leanOnce = memoryReceipts();
	const base = builderBaseTools(workspace, {
		nativePatch: input.provider === "openai",
		freeformPatch: false,
	});
	const archiveTools = agentContextArchiveTools({
		userId: input.userId,
		sessionId: workspace.sessionId,
		signal: workspace.signal,
		storage: input.storage,
	});
	const repositoryContext = automaticRepositoryContext({
		tools: { ...base, ...archiveTools },
		workspace: async () => workspace,
		signal: workspace.signal,
		// Repository instructions arrive as messages, like an AGENTS.md file.
		instructionMessages: { turnStart: true },
		onEvent: input.onEvent,
	});
	const surface = builderToolSurface({
		variant: variant.toolSurface,
		modelId: input.modelId,
		tools: repositoryContext.tools,
		lean: {
			workspace: async () => workspace,
			sessionId: workspace.sessionId,
			turnId: workspace.turnId,
			signal: workspace.signal,
			once: (requestId, _fingerprint, run) => leanOnce(requestId, run),
			installHelpers: input.installHelpers,
			memo,
		},
	});
	const webSearch = input.webSearch ? nativeWebSearchTools(input.provider) : {};
	const fetchTools: ToolSet =
		variant.fetch === "on" ? webFetchTool({ checkHost: nodePublicHost }) : {};
	const planTools: ToolSet =
		variant.plan === "on"
			? planTool({
					now: () => Date.now(),
					onUpdate: input.onPlanUpdate ?? (() => {}),
				})
			: {};
	let tools: ToolSet = {
		...surface.tools,
		...webSearch,
		...fetchTools,
		...planTools,
	};
	const codeMode =
		surface.lean && variant.codeMode !== "off" ? variant.codeMode : null;
	if (codeMode) {
		const runCode = codeModeTool({
			tools,
			signal: workspace.signal,
			sessionId: workspace.sessionId,
			turnId: workspace.turnId,
			mode: codeMode,
			deferred: [],
			// Tools beside the lean surface that programs may call too.
			callable: [...Object.keys(fetchTools), ...Object.keys(planTools)],
			journal: memoryCodeModeJournal(),
		});
		if (runCode)
			tools =
				codeMode === "primary"
					? primaryCodeModeTools({ [CODE_MODE_TOOL]: runCode }, tools)
					: { ...tools, [CODE_MODE_TOOL]: runCode };
	}
	const instructions = agentTurnInstructions({
		session: {},
		lead: variant.lead,
		rigor: variant.rigor === "on",
		tools,
		plugins: [],
		projectKnowledge: null,
		leanShape: surface.lean?.shape,
		leanReadOnly: surface.lean?.readOnly,
		leanWorkingDirectory: surface.lean ? workspace.cwd : undefined,
		codeMode: codeMode && CODE_MODE_TOOL in tools ? codeMode : undefined,
		unattended: true,
		checkInProportion: variant.checks === "proportion",
	});
	return {
		tools,
		// Nobody answers a local run's questions mid-task.
		instructions: `${instructions}\n${UNATTENDED_RUN_INSTRUCTIONS}`,
		leanShape: surface.lean?.shape ?? null,
		input: {
			prepareMessages: repositoryContext.prepare,
			afterTools: repositoryContext.afterTools,
			restoreInstructions: repositoryContext.restoreInstructions,
			archiveHistory: async (history: ModelMessage[]) => {
				const reference = await archiveModelContext(
					input.userId,
					workspace.sessionId,
					history,
					input.storage,
				);
				// A lean surface has no archive tools: it searches a file instead.
				const file = await surface.lean?.saveHistory(reference, history);
				return file ? { file } : reference;
			},
			compactionSnapshot: compactionStateSnapshot({
				workspace: async () => workspace,
			}),
			isUserRequest: (message: ModelMessage) =>
				message.role === "user" && message.content === input.instruction,
		},
	};
}
