import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import type { ApiAgentEvent } from "../domain/api-agent-event";
import {
	type HarnessVariant,
	PRODUCT_HARNESS_VARIANT,
} from "../domain/harness-variant";
import { WorkspaceId } from "../domain/ids";
import { fileContextArchives } from "../server/providers/file-context-archives";
import { apiModelRuntime } from "../server/services/api-model-runtime";
import {
	type ModelAgentRuntime,
	runModelAgent,
} from "../server/services/model-agent-loop";
import { installLocalHelpers } from "./local-helpers";
import { localMachines } from "./local-machines";
import { productHarness } from "./product-harness";
import { LOCAL_PROVIDERS, type LocalProviderName } from "./providers";

/**
 * What a single local agent runs: the product's configuration (lean tool
 * surface, code mode, web fetch, the plan tool) without delegation to other
 * agents, which needs the cloud product's job stack.
 */
export const LOCAL_HARNESS_VARIANT: HarnessVariant = {
	...PRODUCT_HARNESS_VARIANT,
	subagents: "off",
};

export type LocalAgentModel = {
	provider: LocalProviderName;
	apiKey: string;
	/** Defaults to the provider's flagship in providers.ts. */
	modelId?: string;
	/** Points the provider's client somewhere else (a proxy or a compatible gateway). */
	baseUrl?: string;
	reasoning?: string;
	/** Called with the provider's own error text (short, key removed) when it refuses a request. */
	onProviderError?: (message: string) => void;
};

export type LocalAgentRun = {
	/** The task, as the user would type it. */
	prompt: string;
	/** The directory the agent works in; commands and files are relative to it. */
	cwd: string;
	/** Either a provider and key, or a ready runtime (tests give a scripted model). */
	model:
		| LocalAgentModel
		| {
				runtime: ModelAgentRuntime;
				modelId: string;
				provider?: LocalProviderName;
		  };
	signal?: AbortSignal;
	maxSteps?: number;
	variant?: HarnessVariant;
	/** The provider's hosted web search; default: on for a provider's own endpoint. */
	webSearch?: boolean;
	/** Receives text, tool calls and results as they happen. */
	onEvent?: (event: ApiAgentEvent) => void | Promise<void>;
};

export type LocalAgentResult = {
	/** The agent's last message to the user. */
	answer: string;
	messages: ModelMessage[];
};

async function runtimeFor(
	model: LocalAgentRun["model"],
	sessionId: string,
): Promise<{ runtime: ModelAgentRuntime; modelId: string }> {
	if ("runtime" in model) return model;
	const provider = LOCAL_PROVIDERS[model.provider];
	const modelId = model.modelId ?? provider.defaultModel;
	return {
		modelId,
		runtime: await apiModelRuntime({
			provider: provider.provider,
			baseUrl: model.baseUrl ?? provider.baseUrl,
			apiKey: model.apiKey,
			modelId,
			reasoning: model.reasoning,
			anyOpenRouterModel: true,
			userId: "local",
			connectionId: `local:${model.provider}`,
			cacheScopeId: sessionId,
			contextCacheKey: JSON.stringify(["local", model.provider, modelId]),
			fetch: reportingFetch(model.apiKey, model.onProviderError),
		}),
	};
}

/** The shared fetch, telling the caller what a refusing provider said; the key never appears in it. */
function reportingFetch(
	apiKey: string,
	report: ((message: string) => void) | undefined,
): typeof globalThis.fetch {
	const base = globalThis.fetch.bind(globalThis);
	if (!report) return base;
	return async (input, init) => {
		const response = await base(input, init);
		if (response.status >= 400 && response.status < 500) {
			const text = await response
				.clone()
				.text()
				.catch(() => "");
			let message = text;
			try {
				const body = JSON.parse(text);
				message = body?.error?.message ?? body?.message ?? text;
			} catch {}
			report(String(message).replaceAll(apiKey, "[key]").slice(0, 300));
		}
		return response;
	};
}

function lastAssistantText(messages: readonly ModelMessage[]) {
	for (let at = messages.length - 1; at >= 0; at--) {
		const message = messages[at];
		if (message?.role !== "assistant") continue;
		if (typeof message.content === "string") return message.content;
		const text = message.content
			.flatMap((part) => (part.type === "text" ? [part.text] : []))
			.join("");
		if (text.trim()) return text;
	}
	return "";
}

/** How long the runner waits for one background command, and how many it reports back. */
const BACKGROUND_WAIT_SECONDS = 600;
const MAX_BACKGROUND_ROUNDS = 8;

/**
 * Runs the ytimesy coding agent on this computer: the same model loop, tools
 * and instructions the cloud product uses, with the working directory as the
 * machine. Nothing leaves the computer except the model's own requests.
 *
 * Besides the working directory it writes under ~/.ytimesy: workspace
 * commands (bin/), saved context (history/) and archives (archives/).
 */
export async function runLocalAgent(
	run: LocalAgentRun,
): Promise<LocalAgentResult> {
	const sessionId = randomUUID();
	const turnId = randomUUID();
	const controller = new AbortController();
	run.signal?.addEventListener("abort", () =>
		controller.abort(run.signal?.reason),
	);
	const signal = controller.signal;
	const { runtime, modelId } = await runtimeFor(run.model, sessionId);
	const providerName =
		"provider" in run.model && run.model.provider ? run.model.provider : null;
	const home = join(homedir(), ".ytimesy");
	const workspace = {
		machines: localMachines(run.cwd, { pathPrefix: join(home, "bin") }),
		vm: WorkspaceId("local"),
		cwd: run.cwd,
		signal,
		sessionId,
		turnId,
	};
	// Background commands started in this run, by tool-call id, until their id is known.
	const backgroundCalls = new Set<string>();
	const unreported: string[] = [];
	const onEvent = async (event: ApiAgentEvent) => {
		if (
			event.type === "tool-call" &&
			event.name === "bash" &&
			(event.input as { background?: unknown } | null)?.background
		)
			backgroundCalls.add(event.id);
		if (event.type === "tool-result" && backgroundCalls.delete(event.id)) {
			const id = JSON.stringify(event.output).match(
				/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
			)?.[0];
			if (id) unreported.push(id);
		}
		await run.onEvent?.(event);
	};
	const ownEndpoint = !("baseUrl" in run.model && run.model.baseUrl);
	const harness = await productHarness({
		workspace,
		userId: "local",
		modelId,
		provider: providerName
			? LOCAL_PROVIDERS[providerName].provider
			: "anthropic",
		variant: run.variant ?? LOCAL_HARNESS_VARIANT,
		webSearch: run.webSearch ?? (ownEndpoint && providerName !== null),
		instruction: run.prompt,
		storage: fileContextArchives(
			join(home, "archives", sessionId),
			"local",
			sessionId,
		),
		installHelpers: (target) => installLocalHelpers(target, sessionId),
		onEvent,
	});
	let messages: ModelMessage[] = [{ role: "user", content: run.prompt }];
	// The cloud product wakes the agent when a background command exits; here
	// the runner waits for each one and tells the agent, as that notice would.
	for (let round = 0; round < MAX_BACKGROUND_ROUNDS; round++) {
		messages = await runModelAgent(
			{
				userId: "local",
				modelId,
				messages,
				instructions: harness.instructions,
				tools: harness.tools,
				maxSteps: run.maxSteps,
				signal,
				onEvent,
				onStep: async (next) => {
					messages = next;
				},
				...harness.input,
			},
			runtime,
		);
		const id = unreported.shift();
		if (!id || signal.aborted) break;
		const finished = await workspace.machines.exec(
			workspace.vm,
			`ytimesy-job wait ${id} ${BACKGROUND_WAIT_SECONDS}`,
			(BACKGROUND_WAIT_SECONDS + 30) * 1000,
		);
		messages = [
			...messages,
			{
				role: "user",
				content: `Background command ${id} finished or stopped waiting:\n${(finished.stdout + finished.stderr).trim().slice(-4000)}`,
			},
		];
	}
	return { answer: lastAssistantText(messages), messages };
}
