import { PLAN_TEXT_LIMIT, PROPOSE_PLAN_TOOL } from "./agent-plan";
import { PLAN_TOOL } from "./agent-todos";
import type { ApiAgentEvent } from "./api-agent-event";
import { backgroundCommandLabel } from "./background-command";
import {
	CODE_MODE_TOOL,
	type CodeModeResult,
	storedCodeModeResult,
} from "./code-mode";
import { SessionItemId } from "./ids";
import { CALL_MCP_TOOL_TOOL, calledMcpTool } from "./mcp-tool-call";
import {
	REQUEST_PUSH_APPROVAL_TOOL,
	requestedPushApproval,
} from "./push-approval";
import {
	REQUEST_PROJECT_SECRET_TOOL,
	REQUESTABLE_SECRET_KINDS,
	type RequestableSecretKind,
	type RequestedSecret,
	SECRET_REASON_LIMIT,
	SECRET_REQUEST_LIMIT,
} from "./secret-request";
import type { SessionItem } from "./session-item";
import { publicToolDetail } from "./tool-detail";
import { ASK_USER_TOOL, askedQuestions } from "./user-question";

export function recordedContextUsage(items: readonly SessionItem[]) {
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (item.kind === "userMessage" && item.contextUsage)
			return item.contextUsage;
	}
	return undefined;
}

export function applyApiProgress(
	items: readonly SessionItem[],
	turnId: string,
	event: ApiAgentEvent,
): SessionItem[] {
	if (event.type === "usage" || event.type === "context") {
		let index = items.length - 1;
		while (index >= 0 && items[index].kind !== "userMessage") index--;
		return items.map((item, position) =>
			position === index && item.kind === "userMessage"
				? event.type === "usage"
					? { ...item, apiUsage: event.usage }
					: {
							...item,
							contextUsage: {
								...item.contextUsage,
								...(event.context ? { context: event.context } : {}),
								compacting: event.compacting,
							},
						}
				: item,
		);
	}
	if (event.type === "finish")
		return items.map((item) =>
			item.kind === "agentMessage"
				? { ...item, streaming: false }
				: item.kind === "reasoning" && item.durationSeconds == null
					? { ...item, durationSeconds: 0 }
					: item,
		);
	if (event.type === "retract") {
		const retracted = new Set(event.ids.map((id) => `${turnId}:${id}`));
		return items.filter((item) => !retracted.has(item.id));
	}
	const id = SessionItemId(`${turnId}:${event.id}`);
	const existing = items.find((item) => item.id === id);
	let next: SessionItem;
	if (event.type === "reasoning-end")
		return items.map((item) =>
			item.id === id && item.kind === "reasoning"
				? { ...item, durationSeconds: event.durationSeconds }
				: item,
		);
	if (event.type === "text-delta")
		next = {
			kind: "agentMessage",
			id,
			text:
				(existing?.kind === "agentMessage" ? existing.text : "") + event.text,
			streaming: true,
		};
	else if (event.type === "reasoning-delta")
		next = {
			kind: "reasoning",
			id,
			summaries: [
				(existing?.kind === "reasoning" ? existing.summaries.join("") : "") +
					event.text,
			],
		};
	else if (event.type === "tool-result" && event.name === PROPOSE_PLAN_TOOL) {
		// Only a successful call proposes: the tool returns the plan it accepted.
		// A call rejected by validation or a hook leaves no plan waiting.
		const output = event.output as { proposed?: unknown; plan?: unknown };
		const plan = event.failed || output?.proposed !== true ? null : output.plan;
		if (typeof plan !== "string" || !plan.trim()) return [...items];
		next = {
			kind: "planProposal",
			id,
			text: plan.trim().slice(0, PLAN_TEXT_LIMIT),
		};
	} else if (event.type === "tool-call" && event.name === PROPOSE_PLAN_TOOL)
		return [...items];
	else if (
		event.type === "tool-result" &&
		event.name === REQUEST_PROJECT_SECRET_TOOL &&
		requestedSecret(event.output, event.failed)
	) {
		// Only an accepted request waits for the user; a refused one stays a tool call.
		const output = requestedSecret(event.output, event.failed);
		if (!output) return [...items];
		next = { kind: "secretRequest", id, ...output };
	} else if (
		event.type === "tool-result" &&
		event.name === REQUEST_PUSH_APPROVAL_TOOL &&
		requestedPushApproval(event.output, event.failed)
	) {
		// Only a card the tool showed waits for the user; a refused call stays a tool call.
		const request = requestedPushApproval(event.output, event.failed);
		if (!request) return [...items];
		next = { kind: "pushApproval", id, ...request };
	} else if (
		event.type === "tool-call" &&
		event.name === REQUEST_PUSH_APPROVAL_TOOL
	)
		return [...items];
	else if (
		event.type === "tool-result" &&
		event.name === ASK_USER_TOOL &&
		askedQuestions(event.output, event.failed)
	) {
		// Only an accepted question waits for the user; a refused one stays a tool call.
		const questions = askedQuestions(event.output, event.failed);
		if (!questions) return [...items];
		next = { kind: "userQuestion", id, questions };
	} else if (event.type === "tool-call" && event.name === ASK_USER_TOOL)
		return [...items];
	else if (
		(event.type === "tool-call" || event.type === "tool-result") &&
		event.name === PLAN_TOOL
	)
		// The turn's checklist item shows each accepted update (applyPlanUpdate),
		// so the calls themselves add no cards.
		return [...items];
	else if (event.type === "tool-call" || event.type === "tool-result") {
		// A generic MCP call shows as the MCP tool it named, as a direct call would.
		const mcp =
			event.type === "tool-call" && event.name === CALL_MCP_TOOL_TOOL
				? calledMcpTool(event.input)
				: null;
		next = {
			kind: "dynamicToolCall",
			id,
			tool:
				mcp?.name ??
				(event.name === CALL_MCP_TOOL_TOOL &&
				existing?.kind === "dynamicToolCall"
					? existing.tool
					: event.name),
			...(existing?.kind === "dynamicToolCall"
				? { input: existing.input, output: existing.output }
				: {}),
			...(event.type === "tool-call"
				? { input: publicToolDetail(mcp ? mcp.arguments : event.input) }
				: {
						output:
							// A run's record is bounded so it still parses for its card.
							event.name === CODE_MODE_TOOL &&
							!event.failed &&
							event.output &&
							typeof event.output === "object"
								? publicToolDetail(
										storedCodeModeResult(event.output as CodeModeResult),
									)
								: publicToolDetail(event.output, "output"),
					}),
			status:
				event.type === "tool-call"
					? "inProgress"
					: event.failed
						? "failed"
						: "completed",
		};
		const background =
			existing?.kind === "dynamicToolCall" && existing.background
				? existing.background
				: event.type === "tool-result" && !event.failed
					? startedBackgroundCommand(event.output)
					: null;
		if (background) next = { ...next, background };
	} else return [...items];
	return existing
		? items.map((item) => (item.id === id ? next : item))
		: [...items, next];
}

/** A lean command result that started a background command (lean-engine.ts). */
function startedBackgroundCommand(value: unknown) {
	const output = value as {
		background?: unknown;
		status?: unknown;
		id?: unknown;
		command?: unknown;
	} | null;
	return output?.background === true &&
		output.status === "running" &&
		typeof output.id === "string" &&
		typeof output.command === "string"
		? {
				id: output.id,
				label: backgroundCommandLabel(output.command),
				startedAt: Date.now(),
			}
		: null;
}

/**
 * The secrets an accepted request_project_secret call asked for, if any:
 * its list, or the one name an older call returned.
 */
function requestedSecret(
	value: unknown,
	failed: boolean | undefined,
): { secrets: RequestedSecret[] } | null {
	const output = value as {
		requested?: unknown;
		secrets?: unknown;
	} | null;
	if (failed || output?.requested !== true) return null;
	const asked = Array.isArray(output.secrets) ? output.secrets : [output];
	const secrets: RequestedSecret[] = [];
	for (const entry of asked.slice(0, SECRET_REQUEST_LIMIT)) {
		const secret = entry as {
			name?: unknown;
			kind?: unknown;
			reason?: unknown;
		};
		if (
			typeof secret?.name !== "string" ||
			!REQUESTABLE_SECRET_KINDS.includes(secret.kind as RequestableSecretKind)
		)
			return null;
		secrets.push({
			name: secret.name,
			secretKind: secret.kind as RequestableSecretKind,
			reason:
				typeof secret.reason === "string"
					? secret.reason.slice(0, SECRET_REASON_LIMIT)
					: "",
		});
	}
	return secrets.length ? { secrets } : null;
}
