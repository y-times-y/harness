import { APICallError, RetryError } from "ai";
import { CoordinationFailure } from "./conversation-turn-control";
import {
	isWorkspaceAtCapacity,
	isWorkspaceComputeAllowanceExhausted,
	usageCapFailureMessage,
} from "./failure-message";
import { PROJECT_SECRETS_PREPARATION_FAILED } from "./project-secret";
import { redactSecrets } from "./redact-secrets";
import { VerificationPolicyFailure } from "./task-integration-checks";

export class ApiTurnCancelled extends Error {
	constructor() {
		super("API turn was cancelled.");
		this.name = "ApiTurnCancelled";
	}
}

export type ApiTurnFailureStage =
	| "connection"
	| "workspace"
	| "budget"
	| "model"
	| "commit"
	| "coordination"
	| "saving";

const FAILURE_NAMES = new Set([
	"Error",
	"TypeError",
	"TimeoutError",
	"AbortError",
	"SafeApiModelFailure",
	"ApiModelPreparationFailure",
	"UnsupportedEdgeModelEndpoint",
	"InitialAgentReadFailure",
	"HarnessRuntimeFailure",
	"APICallError",
	"AI_APICallError",
	"RetryableCoordinationFailure",
	"WorkspaceProvisionError",
	"WorkspaceCommandError",
	"MachineUsageLimitReached",
	"XaiSubscriptionUnavailable",
	"MachineNotResponding",
]);
const FAILURE_CODES = new Set([
	"ECONNRESET",
	"ETIMEDOUT",
	"ENOTFOUND",
	"ECONNREFUSED",
	"EPIPE",
	"EAI_AGAIN",
	"UND_ERR_SOCKET",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_BODY_TIMEOUT",
	"UND_ERR_CONNECT_TIMEOUT",
	"ERR_STREAM_PREMATURE_CLOSE",
	"23505",
	"40001",
	"40P01",
	"55P03",
	"57014",
	"53300",
	"57P01",
	"08000",
	"08003",
	"08006",
	"08001",
	"08004",
	"08007",
	"08P01",
]);

/** Only predefined diagnostic categories may leave the worker; error text never does. */
export function apiTurnFailureClassification(error: unknown) {
	if (error instanceof HarnessRuntimeFailure)
		return { name: error.name, code: "unknown", stage: error.stage };
	if (error instanceof VerificationPolicyFailure)
		return { name: error.name, code: "unknown", reason: error.reason };
	if (error instanceof CoordinationFailure)
		return {
			name: error.name,
			code: "unknown",
			action: error.action,
			attempts: error.attempts,
			failure: error.failure,
		};
	const name = error instanceof Error ? error.name : "unknown";
	const code =
		error &&
		typeof error === "object" &&
		"code" in error &&
		typeof error.code === "string"
			? error.code
			: "unknown";
	return {
		name: FAILURE_NAMES.has(name) ? name : "unknown",
		code: FAILURE_CODES.has(code) ? code : "unknown",
	};
}

const MACHINE_USAGE_LIMIT_MESSAGE =
	"This chat's machine reached its usage limit, so it cannot start. Your work is preserved; retry once the cloud usage allowance resets or is raised.";

/** The user's (or fleet's) cloud budget cannot fund more machine runtime. */
export class MachineUsageLimitReached extends Error {
	constructor() {
		super(MACHINE_USAGE_LIMIT_MESSAGE);
		this.name = "MachineUsageLimitReached";
	}
}

/**
 * The chat's machine stopped answering (a guard command timed out or failed
 * with no output, even after a wake and retries). Its `cause` keeps the last
 * underlying error for the owner's diagnostics.
 */
export class MachineNotResponding extends Error {
	constructor(cause: unknown) {
		super(
			"This chat's machine isn't responding. Retry in a minute; your work is saved.",
			{ cause },
		);
		this.name = "MachineNotResponding";
	}
}

const MACHINE_ERROR_TAGS = new Set([
	"WorkspaceProvisionError",
	"WorkspaceCommandError",
	"MachineUsageLimitReached",
]);

function machineError(error: unknown, depth = 0): Error | null {
	if (depth > 4 || !(error instanceof Error)) return null;
	const tag = (error as { _tag?: unknown })._tag;
	if (
		MACHINE_ERROR_TAGS.has(error.name) ||
		(typeof tag === "string" && MACHINE_ERROR_TAGS.has(tag))
	)
		return error;
	const inner =
		(error as { providerError?: unknown }).providerError ??
		(RetryError.isInstance(error) ? error.lastError : error.cause);
	return machineError(inner, depth + 1);
}

/**
 * Only fixed wording leaves this function: provider text can name VMs, hosts
 * and internal state, so it selects a reason but is never echoed.
 */
function machineFailureReason(message: string) {
	if (
		/reached its usage limit|allowance is exhausted|allowance cannot fund|execution budget is exhausted/i.test(
			message,
		) ||
		isWorkspaceComputeAllowanceExhausted(message)
	)
		return null;
	if (/total runtime budget|maxRunTotalSeconds|runtime budget/i.test(message))
		return "its runtime budget was used up and could not be extended";
	if (/rejected the .{1,40} machine size/i.test(message))
		return "the provider rejected its machine size; choose a smaller machine size in project settings";
	if (isWorkspaceAtCapacity(message))
		return "the machine plan is at its limit of running machines";
	if (
		/recovery is in progress|being verified|recovery binding changed/i.test(
			message,
		)
	)
		return "its saved state is still being restored";
	if (/too many new machines/i.test(message))
		return "this account started too many new machines in the last hour; wait a few minutes";
	if (/another operation is updating this machine/i.test(message))
		return "another operation was updating it";
	if (/did not become running|stopped before it became running/i.test(message))
		return "it did not finish starting";
	if (/earlier start of this machine was still finishing/i.test(message))
		return "an earlier start of it was still finishing";
	if (/limiting requests|rate.?limit|too many requests|\b429\b/i.test(message))
		return "the machine provider was limiting requests";
	if (/sizing did not complete|did not finish resizing/i.test(message))
		return "it did not finish resizing";
	if (/started but is not answering/i.test(message))
		return "it started but did not answer yet";
	if (/not responding/i.test(message))
		return "the machine provider was not responding";
	if (/must be configured|refuses VM work without usage caps/i.test(message))
		return "this deployment is missing a machine setting";
	if (
		/internal server error|bad gateway|service unavailable|gateway time-?out|\b5\d\d\b|temporar/i.test(
			message,
		)
	)
		return "the machine provider returned a temporary error";
	return "the machine provider reported an error";
}

/**
 * A machine (VM) failure worded as one: it must never read as a model or
 * provider-inference failure. Null when the error is not a machine failure.
 */
const REPOSITORY_FETCH_FAILURE =
	"Couldn't get this chat's code from GitHub. Retry in a moment. If it keeps happening, check that ytimesy still has access to the repository. Your work is saved.";

/** A Git proxy clone or update failed; the model was never asked. */
function repositoryFetchFailed(error: unknown, depth = 0): boolean {
	if (depth > 4 || !(error instanceof Error)) return false;
	if (/Workspace Git proxy transfer failed/.test(error.message)) return true;
	const inner =
		(error as { providerError?: unknown }).providerError ??
		(RetryError.isInstance(error) ? error.lastError : error.cause);
	return repositoryFetchFailed(inner, depth + 1);
}

const WORKSPACE_GIT_FAILURE =
	"Couldn't set up this chat's code on its machine. Retry in a moment. Your work is saved.";

/**
 * A local Git step on the chat's machine failed (checkout, branch check,
 * status); the model was never asked. Fetch and push failures are worded above.
 */
function workspaceGitFailed(error: unknown, depth = 0): boolean {
	if (depth > 4 || !(error instanceof Error)) return false;
	if (/^Workspace Git\b/.test(error.message)) return true;
	const inner =
		(error as { providerError?: unknown }).providerError ??
		(RetryError.isInstance(error) ? error.lastError : error.cause);
	return workspaceGitFailed(inner, depth + 1);
}

/**
 * A usage cap refusal anywhere in the error chain, worded for the user. The
 * cap texts are our own fixed wording, so they are matched even untagged.
 */
function usageCapFailure(error: unknown, depth = 0): string | null {
	if (depth > 4 || !(error instanceof Error)) return null;
	const capped = usageCapFailureMessage(error.message);
	if (capped) return capped;
	const inner =
		(error as { providerError?: unknown }).providerError ??
		(RetryError.isInstance(error) ? error.lastError : error.cause);
	return usageCapFailure(inner, depth + 1);
}

/**
 * The raw cause of a machine failure, redacted, for the owner (logs and the
 * turn's stored error item; never its message): the provider detail the
 * adapter attached, else the machine error's own text. Null when the error
 * is not a machine failure.
 */
export function machineFailureCause(error: unknown): string | null {
	const found = machineError(error);
	if (!found) return null;
	const detail = (found as { detail?: unknown }).detail;
	const tag = (found as { _tag?: unknown })._tag;
	return redactSecrets(
		typeof detail === "string" && detail
			? detail
			: `${typeof tag === "string" ? tag : found.name}: ${found.message}`,
		600,
	);
}

function errorLine(error: unknown): string {
	if (error instanceof Error) {
		const tag = (error as { _tag?: unknown })._tag;
		const code = (error as { code?: unknown }).code;
		const name = typeof tag === "string" ? tag : error.name;
		// Only string codes (ECONNRESET, 40001): DOMException's legacy numeric code says nothing.
		return `${name}${typeof code === "string" && code ? ` [${code}]` : ""}: ${error.message}`;
	}
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error) ?? String(error);
	} catch {
		return String(error);
	}
}

/**
 * The raw cause of any turn failure, redacted and at most 600 characters, for
 * the owner (logs and the turn's stored error item; never its message): the
 * machine detail when there is one, else the error's own text and up to two
 * inner causes (`providerError`, a retry's last error, or `cause`).
 */
export function failureCause(error: unknown): string | null {
	if (error === undefined || error === null) return null;
	const machine = machineFailureCause(error);
	if (machine) return machine;
	const lines: string[] = [];
	let current: unknown = error;
	for (let depth = 0; depth < 3 && current != null; depth++) {
		const line = errorLine(current);
		if (!lines.includes(line)) lines.push(line);
		if (!(current instanceof Error)) break;
		current =
			(current as { providerError?: unknown }).providerError ??
			(RetryError.isInstance(current) ? current.lastError : current.cause);
	}
	return redactSecrets(lines.join(" <- "), 600) || null;
}

export function machineFailureMessage(error: unknown): string | null {
	if (repositoryFetchFailed(error)) return REPOSITORY_FETCH_FAILURE;
	if (workspaceGitFailed(error)) return WORKSPACE_GIT_FAILURE;
	const capped = usageCapFailure(error);
	if (capped) return capped;
	const found = machineError(error);
	if (!found) return null;
	const reason = machineFailureReason(found.message);
	if (reason === null) return MACHINE_USAGE_LIMIT_MESSAGE;
	const action =
		(found as { _tag?: unknown })._tag === "WorkspaceCommandError" ||
		found.name === "WorkspaceCommandError"
			? "could not be reached"
			: "could not start";
	return `The chat's machine ${action}: ${reason}. Retry; your work is preserved.`;
}

/** A ChatGPT plan's allowance is spent; retrying before it resets cannot succeed. */
export class SubscriptionUsageLimitReached extends Error {
	constructor(readonly resetsAt: Date | null) {
		super(subscriptionUsageLimitMessage(resetsAt));
		this.name = "SubscriptionUsageLimitReached";
	}
}

export function subscriptionUsageLimitMessage(
	resetsAt: Date | null,
	now = new Date(),
) {
	const minutes = resetsAt
		? Math.max(1, Math.ceil((resetsAt.getTime() - now.getTime()) / 60_000))
		: null;
	const wait =
		minutes === null
			? "It resets when your plan's usage window renews."
			: `It resets in ${minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`}.`;
	return `Your ChatGPT plan's Codex usage is used up. ${wait} To keep going now, pick a model on an API key. Your work is saved.`;
}

/** The plan's reset time when a 429 body reports a spent allowance; undefined otherwise. */
export function usageLimitReset(body: string): Date | null | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body.slice(0, 65_536));
	} catch {
		return undefined;
	}
	const error = (parsed as { error?: { type?: unknown; resets_at?: unknown } })
		?.error;
	if (error?.type !== "usage_limit_reached") return undefined;
	return typeof error.resets_at === "number" && Number.isFinite(error.resets_at)
		? new Date(error.resets_at * 1000)
		: null;
}

/** The Claude plan's usage window is spent (Claude plan turns); it resets on its own. */
export class ClaudeSubscriptionLimitReached extends Error {
	constructor(readonly resetsAt: Date | null) {
		super(claudeSubscriptionLimitMessage(resetsAt));
		this.name = "ClaudeSubscriptionLimitReached";
	}
}

export function claudeSubscriptionLimitMessage(
	resetsAt: Date | null,
	now = new Date(),
) {
	const minutes = resetsAt
		? Math.max(1, Math.ceil((resetsAt.getTime() - now.getTime()) / 60_000))
		: null;
	const wait =
		minutes === null
			? "It resets when your plan's usage window renews."
			: `It resets in ${minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`}.`;
	return `Your Claude plan's usage is used up. ${wait} To keep going now, pick another model. Your work is saved.`;
}

/** Anthropic refused the Claude subscription token; only a new setup-token fixes it. */
export class ClaudeSubscriptionRefused extends Error {
	constructor() {
		super(
			"Anthropic refused your Claude token. Run `claude setup-token` and paste the new token in Settings > Agents. Your work is saved.",
		);
		this.name = "ClaudeSubscriptionRefused";
	}
}

/** The Claude route reported Anthropic down, overloaded or limiting requests: another route may serve. */
export class ClaudeCodeApiUnavailable extends Error {
	constructor(readonly reason: "outage" | "overloaded" | "rate-limited") {
		super(
			reason === "rate-limited"
				? "Anthropic is limiting your Claude plan's requests right now. Wait a minute, then retry. Your work is saved."
				: reason === "overloaded"
					? "Anthropic is overloaded right now. Retry in a minute. Your work is saved."
					: "Anthropic is having problems right now. Retry in a few minutes. Your work is saved.",
		);
		this.name = "ClaudeCodeApiUnavailable";
	}
}

/** The Claude route itself stopped without an answer (not a subscription problem). */
export class ClaudeCodeRunFailure extends Error {
	constructor(detail: string) {
		super(
			`Claude Agent stopped: ${detail} Your work is saved; retry the turn.`,
		);
		this.name = "ClaudeCodeRunFailure";
	}
}

export class SafeApiModelFailure extends Error {
	readonly classification: ApiModelFailureClassification;

	constructor(error: unknown) {
		super(apiModelFailureMessage(error));
		this.name = "SafeApiModelFailure";
		this.classification = apiModelFailureClassification(error);
		// Operator diagnostics only: not `cause`, which user-facing failure
		// messages unwrap, and not enumerable, so it is never serialized.
		Object.defineProperty(this, "providerError", { value: error });
	}
}

export class UnsupportedEdgeModelEndpoint extends Error {
	constructor() {
		super(
			"Custom model endpoints are not supported here. Select an official provider connection.",
		);
		this.name = "UnsupportedEdgeModelEndpoint";
	}
}

/** Local preparation failures must not be mislabeled as provider inference failures. */
export class ApiModelPreparationFailure extends Error {
	constructor(stage: string) {
		super(
			`API model preparation failed during ${["connection", "catalog", "transport", "credential", "model", "context"].includes(stage) ? stage : "configuration"}. No inference was started. Check the connection configuration before retrying.`,
		);
		this.name = "ApiModelPreparationFailure";
	}
}

/** Catalog/usage failures are not inference failures. Never retain upstream bodies. */
export class SubscriptionMetadataFailure extends Error {
	constructor(
		readonly reason:
			| "timeout"
			| "transport"
			| "invalid-response"
			| "access-challenge"
			| number,
	) {
		super(
			`Codex subscription metadata ${typeof reason === "number" ? `was rejected (HTTP ${reason})` : `failed (${reason})`}. No inference was started. Retry or reconnect Codex.`,
		);
		this.name = "SubscriptionMetadataFailure";
	}
}

/** Every configured egress path to the ChatGPT plan backend was blocked for this request. */
export class CodexEgressUnavailable extends Error {
	constructor(readonly attempts: readonly { path: string; reason: string }[]) {
		super(
			`Codex subscription is unreachable: every network path was blocked (${attempts.map((row) => `${row.path}: ${row.reason}`).join(", ") || "none configured"}). Nothing was sent to the model. Retry in a few minutes; the owner has been alerted.`,
		);
		this.name = "CodexEgressUnavailable";
	}
}

/** The stored subscription login was definitively rejected; only the user can sign in again. */
export class CodexReconnectRequired extends Error {
	constructor() {
		super(
			"Codex login refresh failed; reconnect Codex in Settings → Agents, then retry. This request was not sent.",
		);
		this.name = "CodexReconnectRequired";
	}
}

/**
 * The SuperGrok subscription could not serve a request: its sign-in was
 * rejected ("reconnect"), xAI refused the plan ("not-eligible"), or xAI's
 * sign-in service was briefly unreachable ("unavailable"). The first two wait
 * for the user; every reason lets the turn continue on another connection.
 */
export class XaiSubscriptionUnavailable extends Error {
	constructor(readonly reason: "reconnect" | "not-eligible" | "unavailable") {
		super(
			reason === "reconnect"
				? "Your Grok sign-in expired. Reconnect it in Settings > Agents, then retry."
				: reason === "not-eligible"
					? "Your xAI plan can't use Grok here. Check your SuperGrok or X subscription, or pick another model."
					: "xAI sign-in is unavailable right now. Retry in a few minutes.",
		);
		this.name = "XaiSubscriptionUnavailable";
	}
}

/** Provider SDKs may wrap transport errors; find the typed reconnect cause. */
function reconnectCause(
	error: unknown,
	depth = 0,
): CodexReconnectRequired | null {
	if (error instanceof CodexReconnectRequired) return error;
	if (depth > 4 || !(error instanceof Error) || !("cause" in error))
		return null;
	return reconnectCause(error.cause, depth + 1);
}

/** A local preparation failure must not be presented as a provider rejection. */
export class InitialAgentReadFailure extends Error {
	constructor(
		read:
			| "read_repository_guidance"
			| "read_environment_report"
			| "inspect_changes",
	) {
		super(
			`Workspace preparation failed during ${read}. No model request was started. Repair or reconnect the environment before retrying.`,
		);
		this.name = "InitialAgentReadFailure";
	}
}

export type HarnessRuntimeStage = "context-compaction" | "step-preparation";

/**
 * The harness's own failure inside a model run (compacting the context,
 * preparing a step): no provider rejected anything, so it must never read
 * or log as one. The message is ours, redacted of credential-shaped text.
 */
export class HarnessRuntimeFailure extends Error {
	constructor(
		readonly stage: HarnessRuntimeStage,
		error: unknown,
	) {
		const detail = redactSecrets(
			error instanceof Error ? error.message : String(error),
			500,
		);
		super(
			`${stage === "context-compaction" ? "Context compaction failed" : "Run step preparation failed"}: ${detail} This is a harness failure, not a model or provider failure. Work is preserved.`,
		);
		this.name = "HarnessRuntimeFailure";
		// Its own message decides wording first (apiModelFailureMessage);
		// not `cause` and not enumerable, so it is never serialized.
		Object.defineProperty(this, "runtimeError", { value: error });
	}
}

type ApiModelFailureClassification = ReturnType<
	typeof apiTurnFailureClassification
> & {
	httpStatus: number | null;
	providerCode: string;
	causes: ReturnType<typeof apiTurnFailureClassification>[];
};

const PROVIDER_FAILURE_CODES = new Set([
	"internal_error",
	"server_error",
	"invalid_request_error",
	"invalid_request",
	"invalid_tool_arguments",
	"unsupported_tool",
	"context_length_exceeded",
	"rate_limit_exceeded",
	"insufficient_quota",
	"insufficient_credits",
	"invalid_api_key",
	"model_not_found",
	"invalid_model",
	"content_filter",
]);

function rejectsAssistantPrefill(detail: string) {
	return /requests ending with a model turn|assistant prefill.{0,50}not supported|prefilling.{0,80}not supported/i.test(
		detail,
	);
}

/** Bounded diagnostics only: never log a provider message, body, URL or request. */
export function apiModelFailureClassification(
	error: unknown,
): ApiModelFailureClassification {
	for (let depth = 0; depth < 3 && RetryError.isInstance(error); depth++)
		error = error.lastError;
	if (error instanceof SafeApiModelFailure) return error.classification;
	const status = APICallError.isInstance(error) ? error.statusCode : undefined;
	const code = APICallError.isInstance(error)
		? providerErrorCode(error.data)
		: undefined;
	return {
		...apiTurnFailureClassification(error),
		httpStatus:
			Number.isInteger(status) &&
			status !== undefined &&
			status >= 100 &&
			status <= 599
				? status
				: null,
		providerCode: code && PROVIDER_FAILURE_CODES.has(code) ? code : "unknown",
		causes: modelFailureCauses(error),
	};
}

function modelFailureCauses(error: unknown) {
	const causes: ReturnType<typeof apiTurnFailureClassification>[] = [];
	const seen = new Set<unknown>();
	for (let depth = 0; depth < 4; depth++) {
		if (!error || typeof error !== "object" || !("cause" in error)) break;
		error = error.cause;
		if (!error || seen.has(error)) break;
		seen.add(error);
		causes.push(apiTurnFailureClassification(error));
	}
	return causes;
}

export class IncompleteAgentTurn extends Error {
	constructor(readonly reason: string) {
		super(
			reason === "tool-calls"
				? "The agent reached its tool-step limit without a final result. Work is preserved; continue this task instead of starting a duplicate."
				: "The agent stopped without a complete final result. Work is preserved; continue this task.",
		);
	}
}

/** A step stopped at its length limit without any output: the context left no room to answer. */
export class ContextWindowExhausted extends Error {
	constructor() {
		super(
			"The model stopped at its length limit without output; the conversation leaves it no room to answer.",
		);
		this.name = "ContextWindowExhausted";
	}
}

/** What a provider said about an over-long request, when it said it. */
export type ContextOverflow = {
	/** The model's limit the provider reported. */
	readonly limitTokens?: number;
	/** The size the provider measured for the rejected request. */
	readonly requestedTokens?: number;
};

const CONTEXT_OVERFLOW =
	/context[_ ]length[_ ]exceeded|maximum context length|exceeds? (?:the |its |this model'?s? )?context (?:window|limit|length)|input exceeds the context window|prompt is too long|input is too long|prompt (?:is )?too large|too many (?:input |prompt )?tokens|input token count.{0,40}exceeds|maximum prompt length|exceed context limit|reduce the length of the (?:messages|prompt|input)/i;

/** Provider wordings that carry the sizes, as [pattern, requested group, limit group, output group]. */
const OVERFLOW_SIZES: readonly [RegExp, number, number, number?][] = [
	[
		/maximum context length is (\d+) tokens[\s\S]{0,200}?(?:resulted in|requested(?: about)?|contains?) (\d+) tokens/i,
		2,
		1,
	],
	[/prompt is too long: (\d+) tokens > (\d+)/i, 1, 2],
	[
		/input token count \((\d+)\) exceeds the maximum number of tokens allowed \((\d+)\)/i,
		1,
		2,
	],
	[
		/maximum prompt length is (\d+) but the request contains (\d+) tokens/i,
		2,
		1,
	],
	[
		/prompt contains (\d+) tokens[\s\S]{0,120}?(\d+) maximum context length/i,
		1,
		2,
	],
	[/(\d+) \+ (\d+) > (\d+)/, 1, 3, 2],
];

function overflowSizes(text: string): ContextOverflow {
	for (const [pattern, requested, limit, output] of OVERFLOW_SIZES) {
		const match = pattern.exec(text);
		if (!match) continue;
		const number = (group: number | undefined) =>
			group === undefined ? 0 : Number(match[group]);
		const limitTokens = number(limit) - number(output);
		const requestedTokens = number(requested);
		return {
			...(limitTokens > 0 ? { limitTokens } : {}),
			...(requestedTokens > 0 ? { requestedTokens } : {}),
		};
	}
	return {};
}

/**
 * Whether a provider rejected the request for exceeding the model's context
 * (OpenAI, Anthropic, Gemini, OpenRouter and OpenAI-compatible
 * wordings), with the sizes it reported. Only classifies; never echoes text.
 */
export function contextOverflow(error: unknown): ContextOverflow | null {
	if (error instanceof ContextWindowExhausted) return {};
	const seen = new Set<unknown>();
	for (let current = error, depth = 0; current && depth < 8; depth++) {
		if (typeof current !== "object" || seen.has(current)) break;
		seen.add(current);
		const record = current as {
			message?: unknown;
			code?: unknown;
			type?: unknown;
			data?: unknown;
			error?: unknown;
			responseBody?: unknown;
			providerError?: unknown;
			cause?: unknown;
		};
		const code = APICallError.isInstance(current)
			? providerErrorCode(current.data)
			: typeof record.code === "string"
				? record.code.toLowerCase()
				: undefined;
		const text = [
			record.message,
			record.responseBody,
			record.data && typeof record.data === "object"
				? JSON.stringify(record.data)
				: undefined,
			record.error && typeof record.error === "object"
				? JSON.stringify(record.error)
				: record.error,
		]
			.filter((part): part is string => typeof part === "string")
			.join(" ")
			.slice(0, 8192);
		if (code === "context_length_exceeded" || CONTEXT_OVERFLOW.test(text))
			return overflowSizes(text);
		current = RetryError.isInstance(current)
			? current.lastError
			: (record.providerError ?? record.cause);
	}
	return null;
}

function providerErrorCode(data: unknown): string | undefined {
	if (!data || typeof data !== "object") return undefined;
	const record = data as Record<string, unknown>;
	const nested =
		record.error && typeof record.error === "object"
			? (record.error as Record<string, unknown>)
			: record;
	return typeof nested.code === "string"
		? nested.code.toLowerCase()
		: undefined;
}

/** Workspace failures raised while preparing a model step, worded for the user. */
const WORKSPACE_STEP_FAILURES = [
	"Commit or stash this chat's uncommitted changes before switching branches.",
] as const;

const UNKNOWN_MODEL_FAILURE =
	"The model request failed and the provider didn't say why. Retry, or pick another model. Your work is saved.";

export function apiModelFailureMessage(error: unknown): string {
	// Retry wrappers carry raw request data; classify only their final error, with a bounded unwrap.
	for (let depth = 0; depth < 3 && RetryError.isInstance(error); depth++)
		error = error.lastError;
	const machine = machineFailureMessage(error);
	if (machine) return machine;
	if (error instanceof Error) {
		const known = WORKSPACE_STEP_FAILURES.find((message) =>
			error.message.includes(message),
		);
		if (known)
			return `The workspace could not be prepared: ${known} No model request was started.`;
		// RepositoryGuidanceUnavailable (server/services/repository-guidance.ts):
		// a workspace condition, never a provider failure.
		if (error.name === "RepositoryGuidanceUnavailable")
			return `${error.message} This is a workspace problem, not a model or provider failure.`;
	}
	if (error instanceof HarnessRuntimeFailure) {
		// A runtime error this function already words (a workspace or storage
		// condition) keeps that wording; anything else is the harness's own.
		const inner = (error as { runtimeError?: unknown }).runtimeError;
		const known = inner === undefined ? null : apiModelFailureMessage(inner);
		return known && known !== UNKNOWN_MODEL_FAILURE ? known : error.message;
	}
	if (error instanceof ContextWindowExhausted)
		return "This chat is too long for the model, even after compacting it. Start a new chat with a summary of this one.";
	if (
		error instanceof SafeApiModelFailure ||
		error instanceof SubscriptionUsageLimitReached ||
		error instanceof ClaudeSubscriptionLimitReached ||
		error instanceof ClaudeSubscriptionRefused ||
		error instanceof ClaudeCodeRunFailure ||
		error instanceof ClaudeCodeApiUnavailable ||
		error instanceof UnsupportedEdgeModelEndpoint ||
		error instanceof ApiModelPreparationFailure ||
		error instanceof XaiSubscriptionUnavailable
	)
		return error.message;
	if (
		error instanceof Error &&
		error.message === "Private checkpoint storage is not configured."
	)
		return "Private checkpoint storage is not configured. Work and original context were preserved; configure archive storage before continuing. This is a harness configuration failure, not a provider rejection.";
	if (APICallError.isInstance(error)) {
		const code = providerErrorCode(error.data);
		const detail = `${error.message} ${error.responseBody ?? ""}`.slice(
			0,
			4096,
		);
		const inspectDetails =
			error.statusCode === undefined ||
			error.statusCode === 400 ||
			error.statusCode === 413 ||
			error.statusCode === 422;
		if (error.statusCode === 403 && /18\+ age confirmation/i.test(detail))
			return "OpenRouter requires a one-time 18+ age confirmation for this model. Open Meta in the model selector and choose Confirm 18+, complete it in OpenRouter, then retry. Your work is preserved. No fallback was used.";
		if (error.statusCode === 400 && rejectsAssistantPrefill(detail))
			return "The provider rejected an assistant-prefill request (HTTP 400). This is a conversation-format failure, not an API-key or credit problem. Work is preserved; retry the turn. No fallback was used.";
		if (code === "insufficient_quota" || code === "insufficient_credits")
			return "Your API provider account is out of credit. Add credit with that provider, or pick another model. Your work is saved.";
		if (code === "rate_limit_exceeded")
			return "Your model provider is limiting requests right now. Wait a minute, then retry.";
		if (code === "invalid_api_key")
			return "Your API key was rejected. Replace it in Settings > Agents.";
		if (code === "model_not_found" || code === "invalid_model")
			return "This model isn't available from your provider. Pick another model.";
		if (
			code === "context_length_exceeded" ||
			(inspectDetails &&
				/context.{0,40}(length|window)|maximum.{0,30}tokens|prompt.{0,30}too long/i.test(
					detail,
				))
		)
			return "This chat is too long for the model, even after compacting it. Start a new chat with a summary of this one.";
		if (
			code === "unsupported_tool" ||
			(inspectDetails &&
				/does not support.{0,30}(tools|function calling)|tool_choice.{0,30}(unsupported|invalid)/i.test(
					detail,
				))
		)
			return "This model can't use the tools needed for coding. Pick another model.";
		switch (error.statusCode) {
			case 200:
				return "The model's answer was cut off partway. Your work is saved; check it, then retry.";
			case 401:
				return "Your API key was rejected. Replace it in Settings > Agents.";
			case 402:
				return "Your API provider account is out of credit. Add credit with that provider, or pick another model. Your work is saved.";
			case 403:
				return "This API key can't use the selected model. Pick another model, or check your provider account.";
			case 404:
				return "This model isn't available from your provider. Pick another model.";
			case 408:
			case 504:
				return "The model took too long to respond. Retry in a moment.";
			case 413:
				return "This request is too large for the model. Start a new chat with a summary of this one.";
			case 429:
				return "Your model provider is limiting requests right now. Wait a minute, then retry.";
		}
		if (error.statusCode && error.statusCode >= 500)
			return "Your model provider is having problems right now. Retry in a few minutes. Your work is saved.";
		if (error.statusCode)
			return "Your model provider turned this request down. Retry, or pick another model.";
		if (error.isRetryable)
			return "Couldn't reach your model provider. Retry in a moment.";
	}
	if (error instanceof Error) {
		// Streamed provider errors arrive without an HTTP status; only their wording says why.
		if (/overloaded|over capacity|capacity constraints/i.test(error.message))
			return "The model is overloaded right now. Retry in a minute. Your work is saved.";
		if (error.message.includes("selected model is no longer available"))
			return "This model is no longer available on your connection. Pick another model.";
		if (error.name === "TimeoutError")
			return "The model took too long to respond. Retry in a moment.";
		if (
			error instanceof TypeError &&
			/fetch failed|network error/i.test(error.message)
		)
			return "Couldn't reach your model provider. Check your connection, then retry.";
	}
	return UNKNOWN_MODEL_FAILURE;
}

/** A repository UserPromptSubmit hook refused the turn; shown to the user verbatim. */
export class LifecycleHookRefusal extends Error {
	constructor(reason: string) {
		super(`Blocked by a repository UserPromptSubmit hook: ${reason}`);
		this.name = "LifecycleHookRefusal";
	}
}

export function apiTurnFailureMessage(
	stage: ApiTurnFailureStage,
	error?: unknown,
): string {
	if (error instanceof CoordinationFailure) return error.message;
	if (error instanceof IncompleteAgentTurn) return error.message;
	if (error instanceof InitialAgentReadFailure) return error.message;
	if (error instanceof SubscriptionMetadataFailure) return error.message;
	if (error instanceof CodexEgressUnavailable) return error.message;
	if (error instanceof VerificationPolicyFailure) return error.message;
	if (error instanceof LifecycleHookRefusal) return error.message;
	if (error instanceof MachineNotResponding) return error.message;
	const reconnect = reconnectCause(error);
	if (reconnect) return reconnect.message;
	const machine = machineFailureMessage(error);
	if (machine) return machine;
	switch (stage) {
		case "connection":
			return "The selected API connection changed or was removed. Select a model again; no fallback was used.";
		case "workspace":
			if (
				error instanceof Error &&
				error.message === "Prepared repository path is unavailable."
			)
				return "The prepared repository is missing from this workspace. Repair the environment before retrying.";
			if (
				error instanceof Error &&
				error.message === PROJECT_SECRETS_PREPARATION_FAILED
			)
				return "The project's secrets could not be written into the workspace. Check the workspace and retry; no model request was sent.";
			if (
				error instanceof Error &&
				/(?:LIMIT_EXCEEDED|vcpu_time|memory_time|allowance)/i.test(
					error.message,
				)
			)
				return "You've reached your cloud machine allowance for now. It frees up as the usage window resets.";
			return "This chat's cloud machine couldn't start. Retry in a moment. Your work is saved.";
		case "budget":
			if (
				error instanceof Error &&
				error.message.includes(
					"conversation exceeds the API context safety limit",
				)
			)
				return "This conversation exceeds the API context safety limit. Start a new chat with a handoff summary; no model request was sent.";
			return "This API key reached its daily safety limit in ytimesy. It resets tomorrow; no model request was sent.";
		case "model":
			return apiModelFailureMessage(error);
		case "saving":
			return "The run could not save its latest progress. Check the workspace and connection before retrying.";
		case "coordination":
			return "The conversation coordinator could not confirm this turn's ownership or completion. Work is preserved; inspect the latest task state before continuing.";
		case "commit":
			return "The model finished, but automatic Git handoff failed. Your edits and local commits remain in the workspace. Check Git status, commit hooks, and GitHub access before continuing.";
	}
}
