import { createHash } from "node:crypto";
import type { AssistantModelMessage, LanguageModelUsage } from "ai";
import {
	asSchema,
	generateText,
	hasToolCall,
	isStepCount,
	type LanguageModel,
	type ModelMessage,
	streamText,
	type ToolSet,
} from "ai";
import type { ApiAgentEvent } from "../../domain/api-agent-event";
import type { ApiModelSpeedId } from "../../domain/api-model-list";
import {
	type ApiTokenUsage,
	addApiTokenUsage,
	requestTokenUsage,
} from "../../domain/api-token-usage";
import {
	apiModelFailureClassification,
	type ContextOverflow,
	ContextWindowExhausted,
	contextOverflow,
	HarnessRuntimeFailure,
	type HarnessRuntimeStage,
	IncompleteAgentTurn,
	InitialAgentReadFailure,
	SafeApiModelFailure,
} from "../../domain/api-turn-failure";
import {
	DEGENERATE_RUN_CHARS,
	DegenerateOutput,
	whitespaceRun,
} from "../../domain/degenerate-output";
import {
	harnessModelFamily,
	harnessModelToolInstructions,
	isShellSurface,
} from "../../domain/harness-model-profile";
import {
	type HarnessModelMetric,
	type HarnessToolMetric,
	harnessToolName,
	reportedToolFailure,
	toolFailureClass,
	toolMetricCategory,
} from "../../domain/harness-performance";
import type { InstructionVariant } from "../../domain/harness-variant";
import {
	IMAGE_VIEWING_TOOLS,
	NO_IMAGE_INPUT_INSTRUCTIONS,
	withImagePlaceholders,
} from "../../domain/image-placeholders";
import { instructionProfile } from "../../domain/instruction-profiles";
import { longContextThreshold } from "../../domain/model-pricing";
import { modelStepLimit } from "../../domain/model-workflow";
import { redactSecrets } from "../../domain/redact-secrets";
import type { apiPromptCacheSettings } from "../providers/api-prompt-cache";
import { withProviderOptionsEffort } from "../providers/api-reasoning-effort";
import {
	apiOutputTokenDetails,
	apiTokenUsage,
} from "../providers/api-token-usage";
import type { NativeCompactionInput } from "../providers/model-compaction";
import { prefetchInitialAgentReads } from "./agent-initial-reads";
import { discoverableAgentTools } from "./agent-tool-discovery";
import {
	type ArchivedHistory,
	CONTEXT_SUMMARY_INSTRUCTIONS,
	compactApiHistory,
	contextMeasurement,
	contextTokenPressure,
	estimateContextTokens,
	type FallbackContextPolicy,
	inStreamCompactedHistory,
	modelContextBudget,
	recalledContextMeasurement,
	rememberContextMeasurement,
	retainedUserMessages,
	STATE_SNAPSHOT_HEADING,
	type UserRequestPredicate,
	userMessageBudget,
} from "./api-agent-context";
import { BackgroundHistoryCompaction } from "./background-history-compaction";
import { composedAgentTools } from "./composed-agent-tools";
import { stableHistoryKeyOrder } from "./stable-history-key-order";
import { timed } from "./step-timing";
import { withWebSearchNotes } from "./web-search-notes";

export type { ApiAgentEvent } from "../../domain/api-agent-event";

/** Run from a durable worker with owner-authorized VM tools. No credentials enter the VM or event stream. */
export type ModelAgentInput = {
	/** Whole-turn deadline; defaults to 30 minutes. Unattended runs pass their own limit. */
	turnTimeoutMs?: number;
	userId: string;
	connectionId?: string;
	connectionRevision?: string;
	cacheScopeId?: string;
	maxOutputTokens?: number;
	maxSteps?: number;
	previousContext?: { tokens: number; modelContextWindow: number };
	modelId: string;
	reasoning?: string;
	fast?: boolean;
	/** A listed API model's faster maker endpoint (OpenRouter keys only). */
	speed?: ApiModelSpeedId;
	/**
	 * The route's alternate context window (context-window-option.ts): the
	 * runtime budgets and compacts against it instead of the standard one.
	 */
	alternateContext?: boolean;
	messages: ModelMessage[];
	instructions: string;
	tools: ToolSet;
	/**
	 * Deferred tools (deferred-tools.ts): the tools each request offers, in
	 * order. Tools outside it stay in `tools` but are neither sent nor
	 * callable until they appear here. Read before every step.
	 */
	toolOrder?: () => readonly string[];
	/** True for a step offered no tools (a checker's forced final step). */
	toolsOff?: () => boolean;
	/** Retired and ignored: every turn uses the implementation surface. */
	toolSurface?: "implementation";
	/** Harness variant `instructions`; unset or default = the family's profile. */
	instructionVariant?: InstructionVariant;
	/** A successful call to one of these ends the turn, e.g. a plan waiting for approval. */
	endTurnTools?: readonly string[];
	signal: AbortSignal;
	/** A tool call of the run started executing (after it, aborting the run could cut a write). */
	onToolStart?: () => void;
	onEvent: (event: ApiAgentEvent) => Promise<void>;
	onStep: (messages: ModelMessage[]) => Promise<void>;
	onToolMetric?: (metric: HarnessToolMetric) => void;
	onModelMetric?: (metric: HarnessModelMetric) => void;
	/**
	 * Development: the system prompt and the prepared tool definitions
	 * of each provider call, exactly as sent (model-request-recorder.ts).
	 */
	onModelRequest?: (request: {
		instructions: string;
		tools: ReadonlyArray<Record<string, unknown>> | undefined;
	}) => void;
	beforeStep?: (messages: ModelMessage[]) => Promise<void>;
	prepareMessages?: (messages: ModelMessage[]) => Promise<ModelMessage[]>;
	beforeCompaction?: (messages: ModelMessage[]) => Promise<void>;
	archiveHistory?: (messages: ModelMessage[]) => Promise<ArchivedHistory>;
	restoreInstructions?: (messages: ModelMessage[]) => Promise<ModelMessage[]>;
	/**
	 * Which user-role messages are the person's own requests. When set, every
	 * one of them survives compaction verbatim (bounded); runtime notices do not.
	 */
	isUserRequest?: UserRequestPredicate;
	/**
	 * A deterministic description of the current workspace and command state,
	 * appended after any compaction. Receives the history before compaction.
	 */
	compactionSnapshot?: (
		history: ModelMessage[],
		signal: AbortSignal,
	) => Promise<string | undefined>;
	afterTools?: (messages: ModelMessage[]) => Promise<ModelMessage[]>;
	/**
	 * Compact before the first step even below the threshold, when
	 * `switchAtCompaction` names a model to continue on (lead mode fusion: a
	 * sidekick's pending model switch is carried out at its next round's start).
	 */
	compactFirst?: boolean;
	/**
	 * Asked at each compaction before it runs (lead mode fusion's sidekick):
	 * a model to continue on after it, or null. With one, the compaction
	 * writes a provider-neutral text summary (a native checkpoint is bound to
	 * this model) and the run ends with ModelSwitchAtCompaction once the
	 * compacted history is saved; the caller continues on the new model.
	 */
	switchAtCompaction?: (input: {
		readonly history: ModelMessage[];
		readonly forced: boolean;
	}) => Promise<{
		readonly target: ModelSwitchTarget | null;
		/** A call made to decide (the classifier's): charged to this run's usage. */
		readonly usage?: ApiTokenUsage | null;
	}>;
	/**
	 * Called once when the run gives up, before it throws: the last cleanly
	 * finished history, whether a failed step's partial output was saved after
	 * it, and the ids of that partial output (never retracted by a retry).
	 * `inFlight`, when tools of the failed step had started, is the history that
	 * step would have saved up to its own tool calls, without their results:
	 * a stopped turn keeps the calls it made (closed later with stand-ins).
	 */
	onAttemptFailed?: (state: {
		readonly committed: ModelMessage[];
		readonly droppedStepSaved: boolean;
		readonly uncommittedIds: readonly string[];
		readonly inFlight?: ModelMessage[];
	}) => void;
};

/** The model a run continues on after a compaction (src/server/services/sidekick-model-switch.ts). */
export type ModelSwitchTarget = {
	/** The roleModels spec, e.g. codex:gpt-6.1-sol. */
	readonly spec: string;
	readonly reason: string;
	/** pending: decided earlier; compaction: decided at this compaction. */
	readonly trigger: "pending" | "compaction";
};

/** Budget stops thrown from a step's preparation (product subagents and child runs). */
const BUDGET_STOPS = new Set(["SubagentBudgetExhausted", "ChildBudgetUsed"]);

function isBudgetStop(error: unknown): error is Error {
	for (let current = error, depth = 0; current && depth < 8; depth++) {
		if (current instanceof Error && BUDGET_STOPS.has(current.name)) return true;
		current = (current as { cause?: unknown }).cause;
	}
	return false;
}

/** Ends a run whose history was just compacted for a model switch; it is saved already. */
export class ModelSwitchAtCompaction extends Error {
	constructor(
		readonly target: ModelSwitchTarget,
		/** False when the compaction failed and the history was kept whole. */
		readonly compacted: boolean,
	) {
		super(`Model switch at compaction to ${target.spec}.`);
		this.name = "ModelSwitchAtCompaction";
	}
}

/** A request's settings without the tool-call options of a run with tools (one-off calls send none). */
export function withoutToolSettings<T extends object>(settings: T): T {
	const options = (settings as { providerOptions?: Record<string, unknown> })
		.providerOptions;
	const openai = options?.openai as Record<string, unknown> | undefined;
	if (!openai || !("parallelToolCalls" in openai)) return settings;
	const { parallelToolCalls: _, ...rest } = openai;
	return { ...settings, providerOptions: { ...options, openai: rest } };
}

/**
 * A text context summary's output cap (reasoning included). It was 2048: Luna
 * at max effort on Bedrock spent all of it reasoning over a 415K-token
 * history and returned no text, so a sidekick's round failed on "Context
 * summary was empty". The summary's own length is bounded by
 * compactApiHistory.
 */
export const SUMMARY_MAX_OUTPUT_TOKENS = 8192;

/**
 * Settings for a context summary request: the run's settings at low reasoning
 * effort. Writing a summary needs little reasoning, and a run's high effort
 * can spend the summary's whole output cap before any text.
 */
export function summaryRequestSettings<T extends object>(settings: T): T {
	const options = (
		settings as { providerOptions?: Record<string, Record<string, unknown>> }
	).providerOptions;
	if (!options) return settings;
	return {
		...settings,
		providerOptions: withProviderOptionsEffort(options, "low"),
	};
}

/** Shared streaming/tool loop; credential transports stay in their provider adapters. */
export async function runModelAgent(
	input: ModelAgentInput,
	runtime: ModelAgentRuntime,
): Promise<ModelMessage[]> {
	let result = await executeWithStreamRetries(input, runtime);
	// A progress note is not a final answer, nor is an answer cut off at the
	// output limit; keep sampling.
	for (
		let resumes = 0;
		resumes < 3 &&
		(result.outcome === "continue" || endsWithCommentary(result.messages));
		resumes++
	)
		result = await executeWithStreamRetries(
			{ ...input, messages: result.messages },
			runtime,
		);
	return result.messages;
}

/** Native compaction declined by the harness's own size checks, not by the provider. */
class NativeCompactionRefused extends Error {}

const STREAM_RETRIES = 4;

/**
 * A connection that drops mid-response (read ETIMEDOUT, reset, terminated)
 * would otherwise end the whole run. Resume from the last completed step, but
 * only when the interrupted step had not yet emitted a tool call: nothing ran,
 * so sampling that step again cannot repeat a side effect.
 */
async function executeWithStreamRetries(
	input: ModelAgentInput,
	runtime: ModelAgentRuntime,
	singleStep = false,
) {
	let committed = input.messages;
	let toolCallStarted = false;
	// A durable step owns exactly one inference: once its output is saved, a
	// retry would sample a second step inside it.
	let stepFinished = false;
	let attempt = 0;
	// Providers number a response's parts from zero (Anthropic uses the block
	// index), so a resampled response reuses the dropped one's ids and its text
	// would be appended to the partial text. Each retry gets its own ids, and
	// the dropped response's partial items are retracted first.
	const committedIds = new Set<string>();
	let uncommittedIds = new Set<string>();
	// The token and evaluation reservation covers one inference per history;
	// resampling the same step must not reserve it again.
	let reservedFor: ModelMessage[] | undefined;
	let droppedStep = false;
	let droppedStepSaved = false;
	// A provider's context rejection is retried once per step, after compacting.
	let overflowRetried = false;
	let forceCompaction: ContextOverflow | undefined;
	// The unfinished step's own tool calls, once one of them started executing.
	let inFlight: ModelMessage[] | undefined;
	const tracked: ModelAgentInput = {
		...input,
		onEvent: async (event) => {
			if (event.type === "tool-call") toolCallStarted = true;
			if (
				event.type === "text-delta" ||
				event.type === "reasoning-delta" ||
				event.type === "reasoning-end"
			) {
				if (attempt > 0)
					event = { ...event, id: `${event.id}:retry-${attempt}` };
				uncommittedIds.add(event.id);
			}
			await input.onEvent(event);
		},
		onStep: async (messages) => {
			// A dropped step is still saved, but a retry resamples it from the
			// history before it rather than continuing after its partial output.
			if (droppedStep) {
				droppedStep = false;
				droppedStepSaved = true;
				await input.onStep(messages);
				return;
			}
			committed = messages;
			droppedStepSaved = false;
			toolCallStarted = false;
			for (const id of uncommittedIds) committedIds.add(id);
			uncommittedIds = new Set();
			await input.onStep(messages);
		},
		beforeStep:
			input.beforeStep &&
			(async (messages) => {
				if (reservedFor === committed) return;
				await input.beforeStep?.(messages);
				reservedFor = committed;
			}),
	};
	for (; ; attempt++) {
		try {
			return await executeModelSteps(
				{
					...tracked,
					...(singleStep ? { maxSteps: 1 } : {}),
					messages: committed,
				},
				runtime,
				singleStep,
				(clean) => {
					if (clean) {
						stepFinished = true;
						overflowRetried = false;
					}
					droppedStep = !clean;
				},
				forceCompaction,
				(history) => {
					inFlight = history;
				},
			);
		} catch (error) {
			forceCompaction = undefined;
			const overflow = contextOverflow(error);
			if (
				overflow &&
				!overflowRetried &&
				!toolCallStarted &&
				!input.signal.aborted
			) {
				// Compact below what the provider accepts, then sample the step again.
				overflowRetried = true;
				forceCompaction = overflow;
				const retracted = [...uncommittedIds].filter(
					(id) => !committedIds.has(id),
				);
				uncommittedIds = new Set();
				if (retracted.length)
					await input.onEvent({ type: "retract", ids: retracted });
				continue;
			}
			if (
				attempt >= STREAM_RETRIES ||
				toolCallStarted ||
				(singleStep && stepFinished) ||
				input.signal.aborted ||
				!interruptedStream(error)
			) {
				input.onAttemptFailed?.({
					committed,
					droppedStepSaved,
					uncommittedIds: [...uncommittedIds].filter(
						(id) => !committedIds.has(id),
					),
					...(inFlight ? { inFlight } : {}),
				});
				throw error;
			}
			toolCallStarted = false;
			// An id an earlier, saved step also used is not the dropped response's own.
			const retracted = [...uncommittedIds].filter(
				(id) => !committedIds.has(id),
			);
			uncommittedIds = new Set();
			if (retracted.length)
				await input.onEvent({ type: "retract", ids: retracted });
			await new Promise((done) => setTimeout(done, 2_000 * (attempt + 1)));
		}
	}
}

const INTERRUPTED_STREAM =
	/\b(ETIMEDOUT|ECONNRESET|EPIPE|ENETUNREACH|EAI_AGAIN|UND_ERR_SOCKET|terminated|fetch failed|other side closed)\b/;

/** Network-level interruption anywhere in the failure chain, not a provider rejection. */
function interruptedStream(error: unknown) {
	if (error instanceof DegenerateOutput) return true;
	for (let current = error, depth = 0; current && depth < 8; depth++) {
		if (typeof current !== "object") break;
		const record = current as {
			message?: unknown;
			code?: unknown;
			statusCode?: unknown;
			providerError?: unknown;
			cause?: unknown;
		};
		if (typeof record.statusCode === "number" && record.statusCode !== 200)
			return false;
		if (
			(typeof record.code === "string" &&
				INTERRUPTED_STREAM.test(record.code)) ||
			(typeof record.message === "string" &&
				INTERRUPTED_STREAM.test(record.message))
		)
			return true;
		current = record.providerError ?? record.cause;
	}
	return false;
}

/**
 * OpenAI coding models label mid-turn progress messages "commentary" and the
 * real answer "final_answer". A step that stops on commentary without a tool
 * call has not finished the user's request.
 */
/** The last step ran an end-of-turn tool successfully. */
export function endedByTool(
	messages: readonly ModelMessage[],
	names: readonly string[] | undefined,
) {
	if (!names?.length) return false;
	// Tool results follow the last assistant message; notices may follow them.
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role === "assistant") return false;
		if (
			message.role === "tool" &&
			message.content.some(
				(part) =>
					part.type === "tool-result" &&
					names.includes(part.toolName) &&
					!part.output.type.startsWith("error"),
			)
		)
			return true;
	}
	return false;
}

export function endsWithCommentary(messages: readonly ModelMessage[]) {
	const last = messages.at(-1);
	if (last?.role !== "assistant" || typeof last.content === "string")
		return false;
	if (last.content.some((part) => part.type === "tool-call")) return false;
	const text = [...last.content].reverse().find((part) => part.type === "text");
	return (
		(text?.providerOptions?.openai as { phase?: unknown } | undefined)
			?.phase === "commentary"
	);
}

/** A text-only model is told so and is not offered tools that only return pixels. */
function withoutImageViewing(input: ModelAgentInput): ModelAgentInput {
	const hidden = new Set<string>(IMAGE_VIEWING_TOOLS);
	return {
		...input,
		tools: Object.fromEntries(
			Object.entries(input.tools).filter(([name]) => !hidden.has(name)),
		),
		instructions: `${input.instructions}\n${NO_IMAGE_INPUT_INSTRUCTIONS}`,
	};
}

export const OUTPUT_LIMIT_CONTINUE_NOTE =
	"Your previous response was cut off at the output length limit. Continue exactly where it stopped, without repeating what you already wrote. This is a runtime notice, not a new user request.";

/** The last assistant message is text without tool calls: an answer the length limit cut off. */
function truncatedAnswer(messages: readonly ModelMessage[]) {
	const last = messages.at(-1);
	if (last?.role !== "assistant") return false;
	if (typeof last.content === "string") return Boolean(last.content.trim());
	return (
		!last.content.some((part) => part.type === "tool-call") &&
		last.content.some((part) => part.type === "text" && part.text.trim())
	);
}

/** The cut-off answer was itself the continuation of an earlier cut-off one. */
function continuedAfterTruncation(messages: readonly ModelMessage[]) {
	const previous = messages.at(-2);
	return (
		previous?.role === "user" && previous.content === OUTPUT_LIMIT_CONTINUE_NOTE
	);
}

export const OUTPUT_LIMIT_SPLIT_NOTE =
	"Your previous response reached the output length limit before it finished an answer or a tool call, so nothing from it was kept. Continue the same work in smaller steps: split large edits, files or scripts across several tool calls. This is a runtime notice, not a new user request.";

function exhaustedContext(step: {
	finishReason: string;
	text: string;
	toolCalls: readonly unknown[];
}) {
	return (
		step.finishReason === "length" &&
		!step.toolCalls.length &&
		!step.text.trim()
	);
}

/**
 * A length stop without a complete answer or tool call that spent the output
 * limit (reasoning, or a tool call cut mid-arguments: OpenAI's
 * response.incomplete with max_output_tokens). The context was not full, so
 * compacting cannot help; the step is resampled with a note to work in
 * smaller steps.
 */
function outputLimitCut(
	step: {
		finishReason: string;
		text: string;
		toolCalls: readonly unknown[];
		usage: { outputTokens?: number };
	},
	maxOutputTokens: number | undefined,
) {
	return (
		exhaustedContext(step) &&
		maxOutputTokens !== undefined &&
		step.usage.outputTokens !== undefined &&
		step.usage.outputTokens >= maxOutputTokens * 0.9
	);
}

/**
 * After a provider rejected the context, compact well below what it accepts:
 * 60% of its reported limit, or of this budget's input limit when it reported
 * none (the byte estimate undercounts some tokenizers).
 */
export function overflowCompactionBudget(
	budget: ReturnType<typeof modelContextBudget>,
	overflow: ContextOverflow,
): ReturnType<typeof modelContextBudget> {
	const inputLimitTokens = Math.min(
		budget.inputLimitTokens,
		overflow.limitTokens ?? Number.POSITIVE_INFINITY,
	);
	return {
		inputLimitTokens,
		compactAtTokens: Math.max(
			512,
			Math.min(budget.compactAtTokens, Math.floor(inputLimitTokens * 0.6)),
		),
	};
}

/**
 * A plain Error raised while preparing a step is the harness's own (context
 * compaction, history checks, restored instructions): labelled so it never
 * reads as a provider failure. Provider, abort and typed errors (budget
 * stops, model switches, workspace failures) pass through unchanged.
 */
function harnessRuntimeError(error: unknown, stage: HarnessRuntimeStage) {
	if (
		!(error instanceof Error) ||
		error.constructor !== Error ||
		error.name !== "Error" ||
		isBudgetStop(error)
	)
		return error;
	return new HarnessRuntimeFailure(stage, error);
}

export type ModelAgentRuntime = {
	model: LanguageModel;
	cacheSettings?: ReturnType<typeof apiPromptCacheSettings>;
	maxOutputTokens?: number;
	contextWindow?: number;
	/** False when the model cannot read images: they become placeholders and image tools are hidden. */
	imageInput?: boolean;
	autoCompactTokenLimit?: number;
	/** Optional operating budget; distinct from the provider's hard context window. */
	workingContextTokens?: number;
	/** Retired and ignored. */
	archiveConsumedGuidance?: false;
	prefetchInitialReads?: boolean;
	backgroundCompaction?: boolean;
	fallbackContextPolicy?: FallbackContextPolicy;
	/**
	 * When `compact` (the provider's native compaction) fails, compact with
	 * the harness's own summary under fallbackContextPolicy instead of
	 * failing the step. Set where native compaction is not a documented
	 * contract of the route (OpenAI compaction on Bedrock).
	 */
	compactFallback?: boolean;
	/**
	 * The route answers only streamed requests (the ChatGPT plan backend:
	 * "Stream must be set to true"), so the harness's own summary streams.
	 */
	streamOnly?: boolean;
	compact?: (
		input: NativeCompactionInput,
	) => Promise<{ messages: ModelMessage[]; usage: LanguageModelUsage }>;
	requestSettings?: (instructions: string) => {
		system?: string;
		providerOptions?: Parameters<typeof streamText>[0]["providerOptions"];
	};
};

type ModelAgentStepResult = {
	messages: ModelMessage[];
	outcome: "continue" | "completed";
};

/** A durable orchestrator decides whether another inference is allowed; this call cannot loop. */
export function runModelAgentStep(
	input: ModelAgentInput,
	runtime: ModelAgentRuntime,
) {
	return executeWithStreamRetries(input, runtime, true);
}

async function executeModelSteps(
	input: ModelAgentInput,
	runtime: ModelAgentRuntime,
	singleStep: boolean,
	onStepFinished?: (clean: boolean) => void,
	/** The previous attempt overflowed the context: compact before the first step. */
	forceCompaction?: ContextOverflow,
	/** The running step's history through its started tool calls; undefined once it finishes. */
	onInFlight?: (history: ModelMessage[] | undefined) => void,
): Promise<ModelAgentStepResult> {
	const modelFamily = harnessModelFamily(
		typeof runtime.model === "string" ? "registry" : runtime.model.provider,
		input.modelId,
	);
	if (runtime.imageInput === false) input = withoutImageViewing(input);
	input = {
		...input,
		tools: isShellSurface(Object.keys(input.tools))
			? input.tools
			: composedAgentTools({
					tools: input.tools,
					signal: input.signal,
					onEvent: input.onEvent,
					onToolMetric: input.onToolMetric,
				}),
		instructions: [
			input.instructions,
			harnessModelToolInstructions(
				modelFamily,
				(input.tools.apply_patch as { id?: string } | undefined)?.id ===
					"openai.custom"
					? "freeform"
					: input.tools.apply_patch?.type === "provider",
				Object.keys(input.tools),
				instructionProfile(input.instructionVariant, modelFamily),
			),
		]
			.filter(Boolean)
			.join("\n"),
	};
	input.signal.throwIfAborted();
	const cancelled = new AbortController();
	const runSignal = AbortSignal.any([
		input.signal,
		cancelled.signal,
		// No default wall-clock limit: a run ends when it finishes, is stopped,
		// or its step budget aborts `input.signal`.
		...(input.turnTimeoutMs ? [AbortSignal.timeout(input.turnTimeoutMs)] : []),
	]);
	const { model, cacheSettings = {} } = runtime;
	const tools = discoverableAgentTools(input.tools);
	const reads = new Set<string>();
	let activeToolCount = 0;
	let preparedPromptCharacters = 0;
	let preparedToolCharacters = 0;
	for (const message of input.messages) {
		if (typeof message.content === "string") continue;
		for (const part of message.content) {
			if (
				part.type === "tool-call" &&
				toolMetricCategory(part.toolName) === "read"
			)
				reads.add(
					createHash("sha256")
						.update(JSON.stringify([part.toolName, part.input]))
						.digest("hex"),
				);
		}
	}
	const requestSettings =
		runtime.requestSettings ??
		((instructions: string) => ({ system: instructions }));
	// OpenAI Responses with store:false drops hosted web searches from replayed
	// history; keep each one as a short note instead (web-search-notes.ts).
	const dropsHostedTools =
		runtime.requestSettings?.(input.instructions).providerOptions?.openai
			?.store === false;
	let history = input.messages;
	let pendingCompaction = forceCompaction;
	let compactFirst = input.compactFirst === true;
	// A rejected request proved the last measurement wrong; estimate afresh.
	// Otherwise a run continuing a history this process measured (a follow-up
	// run, a helper's next round, a resumed or retried run) starts from that
	// measurement: a fresh byte estimate of a long reasoning history reads it
	// several times larger than the provider counts it.
	let measured = forceCompaction
		? undefined
		: (recalledContextMeasurement(history, runtime.contextWindow) ??
			(input.previousContext &&
			input.previousContext.modelContextWindow === runtime.contextWindow
				? {
						tokens: input.previousContext.tokens,
						estimatedHistory: estimateContextTokens(
							history.at(-1)?.role === "user" ? history.slice(0, -1) : history,
						),
					}
				: undefined));
	const toolSchemas = await Promise.all(
		Object.entries(tools).map(async ([name, definition]) => ({
			name,
			description: definition.description,
			schema: await asSchema(definition.inputSchema).jsonSchema,
		})),
	);
	const contextBudget = (_messages: ModelMessage[]) =>
		modelContextBudget({
			contextWindow: runtime.contextWindow,
			maxOutputTokens: runtime.maxOutputTokens,
			autoCompactTokenLimit: runtime.autoCompactTokenLimit,
			workingContextTokens: runtime.workingContextTokens,
			fixedTokens: estimateContextTokens({
				instructions: input.instructions,
				tools: toolSchemas.filter(
					({ name }) => !input.toolOrder || input.toolOrder().includes(name),
				),
			}),
		});
	const accumulated = { usage: null as ApiTokenUsage | null };
	/** The history before the last step, when that step was an output-limit cut. */
	let cutBefore: ModelMessage[] | undefined;
	/** Rehydrate exact instructions, then describe current state from the runtime, not from memory. */
	const afterCompaction = async (
		compacted: ModelMessage[],
		original: ModelMessage[],
	) => {
		const restored =
			(await input.restoreInstructions?.(compacted)) ?? compacted;
		if (
			estimateContextTokens(restored) >=
			contextBudget(restored).inputLimitTokens
		)
			throw new Error(
				"Restored repository instructions exceed the model context budget.",
			);
		let snapshot: string | undefined;
		try {
			snapshot = (
				await input.compactionSnapshot?.(original, runSignal)
			)?.trim();
		} catch (error) {
			// State is best effort; the archive tools and workspace remain available.
			console.warn("Compaction state snapshot failed; continuing without it.", {
				message:
					error instanceof Error ? redactSecrets(error.message, 200) : "",
			});
		}
		if (!snapshot) return restored;
		const withSnapshot: ModelMessage[] = [
			...restored,
			{ role: "user", content: `${STATE_SNAPSHOT_HEADING}\n${snapshot}` },
		];
		return estimateContextTokens(withSnapshot) <
			contextBudget(withSnapshot).inputLimitTokens
			? withSnapshot
			: restored;
	};
	const backgroundCompaction = new BackgroundHistoryCompaction();
	// What the running step preparation is doing, for labelHarnessErrors.
	let stage: HarnessRuntimeStage = "step-preparation";
	const labelHarnessErrors =
		<T>(prepare: () => Promise<T>) =>
		() =>
			prepare().catch((error: unknown) => {
				throw harnessRuntimeError(error, stage);
			});
	// Calls of the running step whose execution started. Its assistant message
	// is saved only after every tool returns, so a stop meanwhile would lose them.
	let startedCalls: Extract<
		Exclude<AssistantModelMessage["content"], string>[number],
		{ type: "tool-call" }
	>[] = [];
	// Each recorded usage is one model request: counted, and tagged with the
	// model's long-context tier when its input was that large (per-request
	// tiered pricing, src/domain/model-pricing.ts).
	const longContextAbove = longContextThreshold(input.modelId);
	const recordUsage = async (usage: Parameters<typeof apiTokenUsage>[0]) => {
		accumulated.usage = addApiTokenUsage(
			accumulated.usage,
			requestTokenUsage(apiTokenUsage(usage), longContextAbove),
		);
		await input.onEvent({ type: "usage", usage: accumulated.usage });
	};
	const consumeBackground = async (wait = false) => {
		if (!input.archiveHistory) return;
		const projected = await backgroundCompaction.consume(
			history,
			input.archiveHistory,
			(messages) =>
				estimateContextTokens(messages) < estimateContextTokens(history) &&
				estimateContextTokens(messages) <
					contextBudget(messages).inputLimitTokens,
			wait,
		);
		if (projected !== history) {
			history = await afterCompaction(projected, history);
			measured = undefined;
			await input.onStep(history);
		}
	};
	const startBackground = () => {
		const compact = runtime.compact;
		if (
			!runtime.backgroundCompaction ||
			!compact ||
			!input.archiveHistory ||
			runtime.fallbackContextPolicy === "bound-prefix" ||
			backgroundCompaction.running
		)
			return;
		const budget = contextBudget(history);
		const pressure = contextTokenPressure(history, measured);
		if (
			pressure < budget.compactAtTokens * 0.85 ||
			pressure >= budget.compactAtTokens
		)
			return;
		const lastUser = history.reduce(
			(last, message, index) => (message.role === "user" ? index : last),
			-1,
		);
		// Keep the live user turn outside the frozen prefix, including its tool pairs.
		if (lastUser <= 0) return;
		const older = history.slice(0, lastUser);
		if (estimateContextTokens(older) < budget.compactAtTokens * 0.5) return;
		backgroundCompaction.start(older, async (frozen) => {
			await input.beforeCompaction?.(frozen);
			runSignal.throwIfAborted();
			const checkpoint = await compact({
				messages: frozen,
				instructions: input.instructions,
				tools,
				signal: runSignal,
			});
			await recordUsage(checkpoint.usage);
			return [
				...checkpoint.messages,
				...retainedUserMessages(
					frozen,
					checkpoint.messages,
					input.isUserRequest,
					userMessageBudget(budget),
				),
			];
		});
	};
	try {
		const result = streamText({
			...cacheSettings,
			telemetry: {
				isEnabled: false,
				recordInputs: false,
				recordOutputs: false,
			},
			model,
			messages: input.messages,
			...requestSettings(input.instructions),
			tools,
			prepareStep: labelHarnessErrors(async () => {
				stage = "context-compaction";
				startedCalls = [];
				onInFlight?.(undefined);
				runSignal.throwIfAborted();
				await consumeBackground(
					backgroundCompaction.running &&
						contextTokenPressure(history, measured) >=
							contextBudget(history).compactAtTokens,
				);
				stage = "step-preparation";
				if (runtime.prefetchInitialReads) {
					const prefetched = await timed("model:prefetch", () =>
						prefetchInitialAgentReads({
							messages: history,
							tools: input.tools,
							cacheStablePrefix:
								modelFamily === "openai" &&
								runtime.fallbackContextPolicy !== "bound-prefix",
							signal: runSignal,
							onEvent: input.onEvent,
						}),
					);
					if (prefetched !== history) {
						history = prefetched;
						await input.onStep(history);
					}
				}
				history = (await input.prepareMessages?.(history)) ?? history;
				const estimatedHistory = estimateContextTokens(history);
				const forced = pendingCompaction;
				pendingCompaction = undefined;
				const firstForced = compactFirst;
				compactFirst = false;
				const budget = forced
					? overflowCompactionBudget(contextBudget(history), forced)
					: contextBudget(history);
				const contextTokens = contextTokenPressure(history, measured);
				stage = "context-compaction";
				// Each compaction is a chance to switch models (the cache misses anyway).
				const switchDecision =
					input.switchAtCompaction &&
					(forced || firstForced || contextTokens >= budget.compactAtTokens)
						? await input.switchAtCompaction({
								history,
								forced: firstForced && !forced,
							})
						: null;
				if (switchDecision?.usage) {
					accumulated.usage = addApiTokenUsage(
						accumulated.usage,
						switchDecision.usage,
					);
					await input.onEvent({ type: "usage", usage: accumulated.usage });
				}
				const switchTarget = switchDecision?.target ?? null;
				if (switchTarget) {
					const summarize = async (older: ModelMessage[]) => {
						await input.onEvent({ type: "context", compacting: true });
						try {
							await input.beforeCompaction?.(older);
							runSignal.throwIfAborted();
							const summary = streamText({
								...cacheSettings,
								model,
								...withoutToolSettings(
									summaryRequestSettings(
										requestSettings(CONTEXT_SUMMARY_INSTRUCTIONS),
									),
								),
								prompt: JSON.stringify(older),
								maxRetries: 1,
								maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
								abortSignal: runSignal,
								onError: () => {},
							});
							for await (const part of summary.fullStream)
								if (part.type === "error") throw part.error;
							await recordUsage(await summary.totalUsage);
							return await summary.text;
						} finally {
							await input.onEvent({ type: "context", compacting: false });
						}
					};
					// The archive is a convenience here: a failed upload must not
					// cost the summary (and the switch its compaction).
					const archive = input.archiveHistory;
					const bestEffortArchive =
						archive &&
						(async (messages: ModelMessage[]) => {
							try {
								return await archive(messages);
							} catch (error) {
								console.warn("Context archive failed at a model switch.", {
									message:
										error instanceof Error ? error.message.slice(0, 200) : "",
								});
								return null;
							}
						});
					let switched: { messages: ModelMessage[]; compacted: boolean };
					try {
						switched = await compactApiHistory(
							history,
							summarize,
							{
								...budget,
								compactAtTokens: Math.min(
									budget.compactAtTokens,
									estimatedHistory,
								),
							},
							bestEffortArchive,
							// At a round's start everything before its message is summarized.
							firstForced ? "whole-turns" : "completed-steps",
							input.isUserRequest,
						);
					} catch (error) {
						// An overflow must shrink; a switch at a round's start goes ahead
						// on the whole provider-neutral history instead.
						if (forced || !firstForced) throw error;
						console.warn("Compaction for a model switch failed.", {
							message:
								error instanceof Error ? error.message.slice(0, 200) : "",
						});
						switched = { messages: history, compacted: false };
					}
					if (switched.compacted) {
						history = await afterCompaction(switched.messages, history);
						measured = undefined;
						await input.onStep(history);
					}
					throw new ModelSwitchAtCompaction(switchTarget, switched.compacted);
				}
				const compact = async (older: ModelMessage[], native = true) => {
					await input.onEvent({ type: "context", compacting: true });
					try {
						await input.beforeCompaction?.(older);
						runSignal.throwIfAborted();
						if (native && runtime.compact) {
							const native = await runtime.compact({
								messages: older,
								instructions: input.instructions,
								tools,
								signal: runSignal,
							});
							await recordUsage(native.usage);
							return native.messages;
						}
						const maxOutputTokens =
							runtime.maxOutputTokens === undefined
								? undefined
								: Math.min(runtime.maxOutputTokens, SUMMARY_MAX_OUTPUT_TOKENS);
						if (runtime.streamOnly) {
							const streamed = streamText({
								...cacheSettings,
								model,
								...withoutToolSettings(
									summaryRequestSettings(
										requestSettings(CONTEXT_SUMMARY_INSTRUCTIONS),
									),
								),
								prompt: JSON.stringify(older),
								maxRetries: 1,
								maxOutputTokens,
								abortSignal: runSignal,
								onError: () => {},
							});
							for await (const part of streamed.fullStream)
								if (part.type === "error") throw part.error;
							await recordUsage(await streamed.totalUsage);
							return await streamed.text;
						}
						const summary = await generateText({
							...cacheSettings,
							model,
							...summaryRequestSettings(
								requestSettings(CONTEXT_SUMMARY_INSTRUCTIONS),
							),
							prompt: JSON.stringify(older),
							maxRetries: 1,
							maxOutputTokens,
							abortSignal: runSignal,
						});
						await recordUsage(summary.usage);
						return summary.text;
					} finally {
						await input.onEvent({ type: "context", compacting: false });
					}
				};
				// The harness's own summary (fallbackContextPolicy): the route's
				// compaction when it has no native one, or after a native one failed.
				const ownCompaction = () =>
					compactApiHistory(
						history,
						async (older) => {
							const summary = await compact(older, false);
							if (typeof summary !== "string")
								throw new Error("Expected a text context summary.");
							return summary;
						},
						{
							...budget,
							compactAtTokens: Math.min(
								budget.compactAtTokens,
								estimatedHistory,
							),
						},
						input.archiveHistory,
						runtime.fallbackContextPolicy,
						input.isUserRequest,
					);
				const nativeCompaction = async (): Promise<{
					messages: ModelMessage[];
					compacted: boolean;
				}> => {
					if (contextTokens > budget.inputLimitTokens)
						throw new NativeCompactionRefused(
							"Conversation exceeds this model's context window; native compaction cannot safely accept it.",
						);
					const lastUser = history.reduce(
						(last, message, index) => (message.role === "user" ? index : last),
						-1,
					);
					const keepRecentTurn =
						lastUser > 0 &&
						estimateContextTokens(history.slice(lastUser)) <
							budget.compactAtTokens;
					const recent = keepRecentTurn
						? history.slice(lastUser)
						: lastUser >= 0
							? [history[lastUser]]
							: [];
					const older = keepRecentTurn ? history.slice(0, lastUser) : history;
					// Keep the pending user request after the canonical native checkpoint.
					const compacted = await compact(older);
					if (!Array.isArray(compacted))
						throw new Error("Native compaction returned invalid history.");
					await input.archiveHistory?.(history);
					// Native checkpoints may drop earlier user messages; restore any that are missing.
					const messages = [
						...compacted,
						...retainedUserMessages(
							older,
							[...compacted, ...recent],
							input.isUserRequest,
							userMessageBudget(budget),
						),
						...recent,
					];
					if (estimateContextTokens(messages) >= budget.inputLimitTokens)
						throw new NativeCompactionRefused(
							"Compacted history leaves insufficient context; original checkpoint was preserved.",
						);
					return { messages, compacted: true };
				};
				let prepared: { messages: ModelMessage[]; compacted: boolean };
				if (!forced && contextTokens < budget.compactAtTokens) {
					prepared = { messages: history, compacted: false };
				} else if (runtime.compact) {
					try {
						prepared = await nativeCompaction();
					} catch (error) {
						// The harness's own refusal (nothing usable came back, or nothing
						// was sent) falls back on every route; a provider's failure only
						// where the route asks for it.
						if (
							runSignal.aborted ||
							!(
								runtime.compactFallback ||
								error instanceof NativeCompactionRefused
							)
						)
							throw error;
						console.warn(
							"Native compaction failed; using the harness's own compaction.",
							{
								...apiModelFailureClassification(error),
								message:
									error instanceof Error
										? redactSecrets(error.message, 200)
										: "",
							},
						);
						prepared = await ownCompaction();
					}
				} else {
					prepared = await ownCompaction();
				}
				const beforeCompaction = history;
				history = prepared.messages;
				if (prepared.compacted) {
					history = await afterCompaction(history, beforeCompaction);
					measured = undefined;
					await input.onStep(history);
				}
				stage = "step-preparation";
				// Legacy observations and restored summaries may end in assistant text.
				// Append an input boundary, never rewrite signed or encrypted provider history.
				if (history.at(-1)?.role === "assistant")
					history = [
						...history,
						{
							role: "user",
							content:
								"Continue the current user request using the runtime observations above. This continuation boundary does not authorize new work or change the original requirements.",
						},
					];
				await input.beforeStep?.(history);
				runSignal.throwIfAborted();
				// Same bytes whether the history is in memory or reloaded from jsonb.
				const order = input.toolsOff?.()
					? []
					: input.toolOrder?.().filter((name) => name in tools);
				const sent =
					runtime.imageInput === false
						? withImagePlaceholders(history)
						: history;
				return {
					messages: stableHistoryKeyOrder(
						dropsHostedTools ? withWebSearchNotes(sent) : sent,
					),
					...(order ? { activeTools: order, toolOrder: order } : {}),
				};
			}),
			// SDK retries only retryable request-start failures (with backoff). Never replay a stream after output/tool execution.
			maxRetries: 4,
			streamRetries: 0,
			maxOutputTokens: runtime.maxOutputTokens,
			stopWhen: [
				isStepCount(input.maxSteps ?? modelStepLimit()),
				...(input.endTurnTools?.length
					? [hasToolCall(...input.endTurnTools)]
					: []),
			],
			// Provider errors can echo request credentials; publish only the sanitized error below.
			onError: ({ error }) => {
				if (error instanceof ModelSwitchAtCompaction) return;
				// A subagent stopped at its budget is the runtime's stop, not the provider's.
				if (isBudgetStop(error)) {
					console.warn("Agent budget stop", error.message);
					return;
				}
				// The harness's own failure: its redacted message is the diagnosis.
				if (error instanceof HarnessRuntimeFailure) {
					console.warn("Harness runtime failed", {
						...apiModelFailureClassification(error),
						message: error.message,
					});
					return;
				}
				console.warn(
					error instanceof InitialAgentReadFailure
						? "Agent preparation failed"
						: "Model provider failed",
					apiModelFailureClassification(error),
				);
			},
			abortSignal: runSignal,
			onLanguageModelCallStart: ({
				tools: preparedTools,
				instructions,
				messages,
			}) => {
				activeToolCount = preparedTools?.length ?? 0;
				input.onModelRequest?.({
					instructions: input.instructions,
					tools: preparedTools,
				});
				preparedPromptCharacters = JSON.stringify({
					instructions,
					messages,
				}).length;
				preparedToolCharacters = JSON.stringify(preparedTools ?? []).length;
			},
			onLanguageModelCallEnd: ({ usage, performance, finishReason }) => {
				const counts = apiTokenUsage(usage);
				const outputDetails = apiOutputTokenDetails(usage);
				try {
					input.onModelMetric?.({
						duration_ms: Math.max(0, performance.responseTimeMs),
						first_output_ms: performance.timeToFirstOutputMs ?? null,
						active_tools: activeToolCount,
						input_tokens: counts.inputTokens,
						output_tokens: counts.outputTokens,
						text_output_tokens: outputDetails.textTokens,
						reasoning_output_tokens: outputDetails.reasoningTokens,
						cache_read_tokens: counts.cacheReadTokens,
						prepared_prompt_characters: preparedPromptCharacters,
						prepared_tool_characters: preparedToolCharacters,
						outcome:
							finishReason === "tool-calls"
								? "tool_calls"
								: finishReason === "length"
									? "limited"
									: finishReason === "error" ||
											finishReason === "content-filter"
										? "failed"
										: "completed",
					});
				} catch {
					/* Metrics cannot interrupt inference. */
				}
			},
			onToolExecutionStart: ({ toolCall }) => {
				// Provider-neutral: no reasoning or provider item ids that a native
				// replay would require to arrive together with their reasoning.
				input.onToolStart?.();
				if (!toolCall.providerExecuted) {
					startedCalls = [
						...startedCalls,
						{
							type: "tool-call",
							toolCallId: toolCall.toolCallId,
							toolName: toolCall.toolName,
							input: toolCall.input,
						},
					];
					onInFlight?.([
						...history,
						{ role: "assistant", content: startedCalls },
					]);
				}
				startBackground();
			},
			onToolExecutionEnd: ({ toolCall, toolOutput, toolExecutionMs }) => {
				const category = toolMetricCategory(toolCall.toolName);
				const key =
					category === "read"
						? createHash("sha256")
								.update(JSON.stringify([toolCall.toolName, toolCall.input]))
								.digest("hex")
						: null;
				const repeated = key !== null && reads.has(key);
				if (key !== null) reads.add(key);
				// No arguments, outputs, paths, errors, or custom model names leave this hook.
				try {
					input.onToolMetric?.({
						tool_name: harnessToolName.safeParse(toolCall.toolName).success
							? (toolCall.toolName as HarnessToolMetric["tool_name"])
							: "other",
						category,
						error_class:
							toolOutput.type === "tool-error"
								? "execution"
								: toolFailureClass(toolOutput.output),
						duration_ms: Math.max(0, toolExecutionMs),
						outcome:
							toolOutput.type === "tool-error" ||
							reportedToolFailure(toolOutput.output)
								? "failed"
								: "completed",
						repeated_read: repeated,
					});
				} catch {
					/* Observability cannot interrupt coding. */
				}
			},
			onStepFinish: async (step) => {
				// The SDK also finishes a step whose stream failed; only a clean one
				// counts. A step cut off at the length limit before any output is
				// resampled after compaction, so it does not count either.
				onStepFinished?.(
					step.finishReason !== "error" && !exhaustedContext(step),
				);
				cutBefore = outputLimitCut(step, runtime.maxOutputTokens)
					? history
					: undefined;
				await recordUsage(step.usage);
				if (
					runtime.contextWindow &&
					step.usage.inputTokens !== undefined &&
					step.usage.outputTokens !== undefined
				) {
					await input.onEvent({
						type: "context",
						compacting: false,
						context: {
							last: {
								totalTokens: step.usage.inputTokens + step.usage.outputTokens,
							},
							modelContextWindow: runtime.contextWindow,
						},
					});
				}
				startedCalls = [];
				onInFlight?.(undefined);
				const historyBeforeStep = history;
				history = [...historyBeforeStep, ...step.response.messages];
				// The provider compacted this request's input in-stream (OpenAI
				// context_management): its checkpoint replaces everything before
				// it. Its cost is in this step's usage, recorded above, once.
				const inStream = inStreamCompactedHistory(
					historyBeforeStep,
					step.response.messages,
					input.isUserRequest,
					userMessageBudget(contextBudget(history)),
				);
				if (inStream) {
					try {
						await input.archiveHistory?.(history);
					} catch (error) {
						console.warn("Context archive failed at in-stream compaction.", {
							message:
								error instanceof Error ? redactSecrets(error.message, 200) : "",
						});
					}
					history = await afterCompaction(inStream, history);
				}
				history = (await input.afterTools?.(history)) ?? history;
				if (inStream) measured = undefined;
				else if (
					step.usage.inputTokens !== undefined &&
					step.usage.outputTokens !== undefined
				) {
					measured = contextMeasurement(
						historyBeforeStep,
						step.response.messages,
						step.usage.inputTokens,
						step.usage.outputTokens,
					);
					rememberContextMeasurement(history, measured, runtime.contextWindow);
				}
				await input.onStep(history);
			},
		});
		const reasoningStarted = new Map<string, number>();
		// OpenRouter's search tool runs on its server and reports only cited
		// sources; show them as one search per step unless a search call did.
		let searchCalled = false;
		let citedSources: { url: string; title?: string }[] = [];
		let searchStep = 0;
		// A response whose answer text or tool-call arguments degenerate into
		// whitespace would run to the output cap: cut it as an interrupted
		// stream ("terminated"), which resamples the step before any tool ran.
		let whitespace = whitespaceRun();
		const degenerate = (delta: string) => {
			const run = whitespace(delta);
			if (run >= DEGENERATE_RUN_CHARS) throw new DegenerateOutput(run);
		};
		for await (const part of result.fullStream) {
			switch (part.type) {
				case "start-step":
					searchCalled = false;
					citedSources = [];
					whitespace = whitespaceRun();
					break;
				case "tool-input-delta":
					degenerate(part.delta);
					break;
				case "source":
					if (
						part.sourceType === "url" &&
						!searchCalled &&
						!citedSources.some((source) => source.url === part.url)
					)
						citedSources.push({
							url: part.url,
							...(part.title ? { title: part.title } : {}),
						});
					break;
				case "finish-step":
					if (citedSources.length && !searchCalled) {
						const id = `cited-search-${searchStep++}`;
						await input.onEvent({
							type: "tool-call",
							id,
							name: "web_search",
							input: { sources: citedSources.length },
						});
						await input.onEvent({
							type: "tool-result",
							id,
							name: "web_search",
							output: { sources: citedSources },
						});
					}
					citedSources = [];
					break;
				case "reasoning-start":
					reasoningStarted.set(part.id, Date.now());
					break;
				case "reasoning-end":
					await input.onEvent({
						type: "reasoning-end",
						id: part.id,
						durationSeconds: Math.max(
							0,
							(Date.now() - (reasoningStarted.get(part.id) ?? Date.now())) /
								1000,
						),
					});
					break;
				case "text-delta":
				case "reasoning-delta":
					if (part.type === "text-delta") degenerate(part.text);
					await input.onEvent({
						type: part.type,
						id: part.id,
						text: part.text,
					});
					break;
				case "tool-call":
					if (
						part.toolName === "web_search" ||
						part.toolName === "google_search"
					)
						searchCalled = true;
					await input.onEvent({
						type: "tool-call",
						id: part.toolCallId,
						name: part.toolName,
						input: part.input,
					});
					break;
				case "tool-result":
					await input.onEvent({
						type: "tool-result",
						id: part.toolCallId,
						name: part.toolName,
						output: part.output,
					});
					break;
				case "tool-error":
					await input.onEvent({
						type: "tool-result",
						id: part.toolCallId,
						name: part.toolName,
						output:
							part.error instanceof Error
								? part.error.message
								: "Tool execution failed.",
						failed: true,
					});
					break;
				case "error":
					// A budget stop is the runtime's, not the provider's: its caller
					// recognizes it (and hands the child's last message on) only unwrapped.
					if (
						part.error instanceof InitialAgentReadFailure ||
						part.error instanceof HarnessRuntimeFailure ||
						part.error instanceof ModelSwitchAtCompaction ||
						isBudgetStop(part.error)
					)
						throw part.error;
					throw new SafeApiModelFailure(part.error);
				case "abort":
					throw new Error("Model run cancelled.");
			}
		}
		await consumeBackground(true);
		const usage = accumulated.usage ?? apiTokenUsage(await result.totalUsage);
		const ended = endedByTool(history, input.endTurnTools);
		const reason = ended ? "stop" : await result.finishReason;
		if (
			!ended &&
			singleStep &&
			(reason === "tool-calls" ||
				(reason === "stop" && endsWithCommentary(history)))
		)
			return { messages: history, outcome: "continue" };
		if (reason === "length" && !ended && cutBefore) {
			// Resampled once with the note; a second cut in a row gives up.
			if (cutBefore.at(-1)?.content === OUTPUT_LIMIT_SPLIT_NOTE)
				throw new IncompleteAgentTurn(reason);
			history = [
				...cutBefore,
				{ role: "user", content: OUTPUT_LIMIT_SPLIT_NOTE },
			];
			await input.onStep(history);
			return { messages: history, outcome: "continue" };
		}
		if (reason === "length" && !ended) {
			if (!truncatedAnswer(history)) throw new ContextWindowExhausted();
			// An answer cut off at the output limit continues once from where it stopped.
			if (continuedAfterTruncation(history))
				throw new IncompleteAgentTurn(reason);
			history = [
				...history,
				{ role: "user", content: OUTPUT_LIMIT_CONTINUE_NOTE },
			];
			await input.onStep(history);
			return { messages: history, outcome: "continue" };
		}
		if (reason !== "stop") throw new IncompleteAgentTurn(reason);
		await input.onEvent({
			type: "finish",
			inputTokens: usage.inputTokens ?? null,
			outputTokens: usage.outputTokens ?? null,
			reason,
		});
		return { messages: history, outcome: "completed" };
	} finally {
		cancelled.abort();
		await backgroundCompaction.settle();
	}
}
