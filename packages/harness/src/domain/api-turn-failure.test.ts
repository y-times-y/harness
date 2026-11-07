import { APICallError } from "ai";
import { expect, it } from "vitest";
import {
	apiModelFailureClassification,
	apiModelFailureMessage,
	apiTurnFailureClassification,
	apiTurnFailureMessage,
	CodexReconnectRequired,
	ContextWindowExhausted,
	contextOverflow,
	failureCause,
	HarnessRuntimeFailure,
	MachineUsageLimitReached,
	SafeApiModelFailure,
	SubscriptionMetadataFailure,
} from "./api-turn-failure";
import {
	FLEET_LIFETIME_CAP_MESSAGE,
	FLEET_MONTHLY_CAP_MESSAGE,
	failureMessage,
	USER_USAGE_CAP_MESSAGE,
} from "./failure-message";
import { PROJECT_SECRETS_PREPARATION_FAILED } from "./project-secret";

it("preserves safe metadata failure categories in the visible model-stage error", () => {
	for (const reason of [
		"timeout",
		"transport",
		"invalid-response",
		403,
	] as const) {
		const error = new SubscriptionMetadataFailure(reason);
		expect(apiTurnFailureMessage("model", error)).toBe(error.message);
		expect(error.message).toContain("No inference was started");
	}
});

it("logs only recognized failure classifications, never arbitrary error properties", () => {
	expect(
		apiTurnFailureClassification(
			Object.assign(new Error("private query"), { code: "ECONNRESET" }),
		),
	).toEqual({ name: "Error", code: "ECONNRESET" });
	expect(
		apiTurnFailureClassification(
			new DOMException("private host", "TimeoutError"),
		),
	).toEqual({ name: "TimeoutError", code: "unknown" });
	expect(
		apiTurnFailureClassification({
			name: "PRIVATE",
			code: "PRIVATE",
			message: "secret",
		}),
	).toEqual({ name: "unknown", code: "unknown" });
});

it("distinguishes safe failure stages without exposing provider details", () => {
	expect(apiTurnFailureMessage("workspace")).toContain("cloud machine");
	expect(apiTurnFailureMessage("budget")).toContain(
		"no model request was sent",
	);
	expect(apiTurnFailureMessage("model")).toContain("Retry");
});

it("reports a project secrets failure as a workspace failure, never a connection change", () => {
	const message = apiTurnFailureMessage(
		"workspace",
		new Error(PROJECT_SECRETS_PREPARATION_FAILED),
	);
	expect(message).toContain("secrets could not be written");
	expect(message).not.toContain("API connection");
});

function providerFailure(statusCode: number, data?: unknown) {
	return new APICallError({
		message: "Secret request: sk-fixture-do-not-show",
		url: "https://example.com/v1/chat/completions",
		requestBodyValues: { apiKey: "sk-fixture-do-not-show" },
		responseBody: "sk-fixture-do-not-show",
		statusCode,
		data,
	});
}

it("explains provider age confirmation without blaming the key or exposing raw errors", () => {
	const error = new APICallError({
		message: "Provider rejected request",
		url: "https://openrouter.ai/api/v1/chat/completions",
		requestBodyValues: { apiKey: "sk-private-do-not-show" },
		statusCode: 403,
		responseBody: JSON.stringify({
			error: {
				message:
					"This model requires 18+ age confirmation. sk-private-do-not-show",
			},
		}),
	});
	const message = apiTurnFailureMessage("model", error);
	expect(message).toContain("one-time 18+ age confirmation");
	expect(message).toContain("model selector");
	expect(message).not.toContain("sk-private");
	expect(message).not.toContain("key does not have access");
});

it.each([
	[401, "API key"],
	[402, "out of credit"],
	[403, "can't use the selected model"],
	[404, "isn't available"],
	[429, "limiting requests"],
	[503, "having problems"],
])(
	"explains provider HTTP %i without exposing request data",
	(status, reason) => {
		const message = apiTurnFailureMessage("model", providerFailure(status));
		expect(message).toContain(reason);
		expect(message).not.toContain("sk-fixture-do-not-show");
	},
);

it("uses structured provider codes when HTTP 400 is too broad", () => {
	const error = providerFailure(400, {
		error: { code: "context_length_exceeded" },
	});
	expect(apiTurnFailureMessage("model", error)).toContain("too long");
});

it.each([
	"Requests ending with a model turn are not supported.",
	"Assistant prefill is not supported for this model.",
	"Prefilling assistant responses is not supported for this model.",
])(
	"explains unsupported assistant prefill without echoing provider data: %s",
	(reason) => {
		const error = new APICallError({
			message: reason,
			url: "https://example.com/v1/chat/completions",
			requestBodyValues: { apiKey: "sk-private" },
			responseBody: JSON.stringify({
				error: { message: `${reason} sk-private` },
			}),
			statusCode: 400,
		});
		const visible = apiTurnFailureMessage("model", error);
		expect(visible).toContain("conversation-format failure");
		expect(visible).not.toContain("sk-private");
	},
);

it("classifies accepted-request stream failures without leaking payloads", () => {
	const error = providerFailure(200, {
		error: { code: "internal_error", message: "secret" },
	});
	expect(apiModelFailureClassification(error)).toMatchObject({
		httpStatus: 200,
		providerCode: "internal_error",
	});
	expect(apiTurnFailureMessage("model", error)).toContain("cut off partway");
	expect(JSON.stringify(apiModelFailureClassification(error))).not.toContain(
		"secret",
	);
	expect(
		apiModelFailureClassification(
			providerFailure(200, { error: { code: "sk-secret" } }),
		).providerCode,
	).toBe("unknown");
});

it("retains bounded transport cause categories through safe wrapping", () => {
	const socket = Object.assign(new Error("private socket headers"), {
		code: "UND_ERR_SOCKET",
	});
	const error = new APICallError({
		message: "private response",
		url: "https://private.example",
		requestBodyValues: { token: "sk-private" },
		statusCode: 200,
		cause: new TypeError("private fetch", { cause: socket }),
	});
	const classification = apiModelFailureClassification(error);
	expect(classification.causes).toEqual([
		{ name: "TypeError", code: "unknown" },
		{ name: "Error", code: "UND_ERR_SOCKET" },
	]);
	expect(apiModelFailureClassification(new SafeApiModelFailure(error))).toEqual(
		classification,
	);
	expect(JSON.stringify(classification)).not.toContain("private");
});

it("bounds cyclic cause chains and excludes arbitrary codes", () => {
	const error = Object.assign(new Error("secret"), {
		code: "secret",
		cause: undefined as unknown,
	});
	error.cause = error;
	const classification = apiModelFailureClassification(error);
	expect(classification.causes).toEqual([{ name: "Error", code: "unknown" }]);
});

it("never stores raw provider text in the safe failure", () => {
	const failure = new SafeApiModelFailure(providerFailure(429));
	expect(failure.message).toContain("limiting requests");
	expect(failure.message).not.toContain("sk-fixture-do-not-show");
	expect(apiTurnFailureMessage("model", failure)).toBe(failure.message);
});

it("identifies missing local archive configuration without publishing arbitrary error text", () => {
	expect(
		new SafeApiModelFailure(
			new Error("Private checkpoint storage is not configured."),
		).message,
	).toContain("harness configuration failure");
	expect(
		new SafeApiModelFailure(
			new Error("Private checkpoint storage is not configured. secret"),
		).message,
	).not.toContain("secret");
});

it("distinguishes context and usage budgets", () => {
	expect(
		apiTurnFailureMessage(
			"budget",
			new Error("This conversation exceeds the API context safety limit."),
		),
	).toContain("handoff summary");
	expect(apiTurnFailureMessage("budget", new Error("usage limit"))).toContain(
		"safety limit",
	);
});

it("tells the user to reconnect even when the SDK wraps the refresh failure", () => {
	const wrapped = new Error("Cannot connect to API", {
		cause: new CodexReconnectRequired(),
	});
	expect(apiTurnFailureMessage("model", wrapped)).toContain("reconnect Codex");
	expect(
		apiTurnFailureMessage("model", new CodexReconnectRequired()),
	).toContain("reconnect Codex");
});

it("says the provider is overloaded when a streamed error reports it", () => {
	const overloaded = new Error(
		"Our servers are currently overloaded. Please try again later.",
	);
	overloaded.name = "AI_StreamProviderError";
	expect(apiModelFailureMessage(overloaded)).toBe(
		"The model is overloaded right now. Retry in a minute. Your work is saved.",
	);
	expect(apiModelFailureMessage(new Error("something else"))).toContain(
		"didn't say why",
	);
});

/** Shaped like Effect's Data.TaggedError, which the domain layer cannot import. */
function taggedMachineError(
	tag: "WorkspaceProvisionError" | "WorkspaceCommandError",
	message: string,
) {
	return Object.assign(new Error(message), { name: tag, _tag: tag });
}

it("reports a machine that failed to start as a machine failure, not a model failure", () => {
	const error = taggedMachineError(
		"WorkspaceProvisionError",
		"conflict: vm vm-test has used its total runtime budget of 900s (903s used); raise maxRunTotalSeconds to start it again",
	);
	// The model loop wraps stream errors, including step preparation's.
	const wrapped = new SafeApiModelFailure(error);
	for (const message of [
		wrapped.message,
		apiTurnFailureMessage("model", wrapped),
		apiTurnFailureMessage("workspace", error),
	]) {
		expect(message).toContain("The chat's machine could not start");
		expect(message).toContain("Retry; your work is preserved");
		expect(message).not.toMatch(/model request failed|provider reason/i);
		expect(message).not.toContain("vm-b216");
		expect(message).not.toContain("maxRunTotalSeconds");
	}
	expect(apiTurnFailureClassification(error).name).toBe(
		"WorkspaceProvisionError",
	);
});

it("names a provider internal error on a machine as temporary without echoing it", () => {
	const message = apiModelFailureMessage(
		new SafeApiModelFailure(
			taggedMachineError("WorkspaceProvisionError", "Internal server error"),
		),
	);
	expect(message).toBe(
		"The chat's machine could not start: the machine provider returned a temporary error. Retry; your work is preserved.",
	);
});

it("says the chat's machine reached its usage limit when the budget cannot fund it", () => {
	expect(
		apiTurnFailureMessage("model", new MachineUsageLimitReached()),
	).toMatch(/^This chat's machine reached its usage limit/);
	expect(
		apiTurnFailureMessage(
			"model",
			taggedMachineError(
				"WorkspaceProvisionError",
				"Your cloud execution allowance is exhausted.",
			),
		),
	).toBe(USER_USAGE_CAP_MESSAGE);
});

it("words fleet caps as the beta's shared budget, tagged or not", () => {
	for (const [text, expected] of [
		[
			"The fleet cloud execution budget is exhausted.",
			FLEET_MONTHLY_CAP_MESSAGE,
		],
		[
			"The lifetime fleet cloud execution budget is exhausted.",
			FLEET_LIFETIME_CAP_MESSAGE,
		],
	]) {
		expect(
			apiTurnFailureMessage(
				"model",
				taggedMachineError("WorkspaceProvisionError", text),
			),
		).toBe(expected);
		expect(
			apiTurnFailureMessage(
				"workspace",
				new Error("wrapped", { cause: new Error(text) }),
			),
		).toBe(expected);
		expect(
			apiModelFailureMessage(new SafeApiModelFailure(new Error(text))),
		).toBe(expected);
		expect(failureMessage(new Error(text))).toBe(expected);
	}
	expect(FLEET_MONTHLY_CAP_MESSAGE).toContain("shared cloud budget");
});

it("keeps unknown machine error text out of the user message", () => {
	const message = apiTurnFailureMessage(
		"model",
		taggedMachineError(
			"WorkspaceCommandError",
			"token sk-secret at https://vm-x.example.test failed",
		),
	);
	expect(message).toBe(
		"The chat's machine could not be reached: the machine provider reported an error. Retry; your work is preserved.",
	);
});

it("leaves non-machine failures to the existing provider wording", () => {
	expect(apiModelFailureMessage(new Error("something odd"))).toContain(
		"didn't say why",
	);
});

it("says the repository could not be fetched when a Git proxy transfer fails", () => {
	const fetch = new Error(
		"Workspace Git proxy transfer failed; check repository access.",
	);
	for (const error of [
		fetch,
		new SafeApiModelFailure(new Error("fiber failure", { cause: fetch })),
	]) {
		const message = apiModelFailureMessage(error);
		expect(message).toContain("get this chat's code from GitHub");
		expect(message).not.toContain("model request failed");
	}
});

it("words a failed workspace Git step as a workspace problem, the same at every stage", () => {
	const git = new Error("Workspace Git rejected the branch name.");
	const wrapped = new SafeApiModelFailure(
		new Error("fiber failure", { cause: git }),
	);
	const messages = [
		apiModelFailureMessage(git),
		apiModelFailureMessage(wrapped),
		apiTurnFailureMessage("model", git),
		apiTurnFailureMessage("workspace", git),
		apiTurnFailureMessage(
			"workspace",
			new Error("Workspace Git could not check the branch name (exit 124)."),
		),
	];
	expect(new Set(messages).size).toBe(1);
	expect(messages[0]).toContain("set up this chat's code");
	expect(messages[0]).not.toMatch(/model request failed|couldn't start/);
});

function rejected(message: string, data?: unknown, statusCode = 400) {
	return new APICallError({
		message,
		url: "https://provider.invalid/v1",
		requestBodyValues: {},
		statusCode,
		responseBody: data ? JSON.stringify(data) : undefined,
		data,
		isRetryable: false,
	});
}

it("recognizes each provider's context overflow and the sizes it reports", () => {
	expect(
		contextOverflow(
			rejected(
				"This model's maximum context length is 128000 tokens. However, your messages resulted in 130532 tokens.",
				{ error: { code: "context_length_exceeded" } },
			),
		),
	).toEqual({ limitTokens: 128000, requestedTokens: 130532 });
	// OpenAI Responses and the ChatGPT plan backend name only the code.
	expect(
		contextOverflow(
			rejected("Your input exceeds the context window of this model.", {
				error: { code: "context_length_exceeded" },
			}),
		),
	).toEqual({});
	expect(
		contextOverflow(
			rejected("prompt is too long: 215000 tokens > 200000 maximum"),
		),
	).toEqual({ limitTokens: 200000, requestedTokens: 215000 });
	expect(
		contextOverflow(
			rejected(
				"input length and `max_tokens` exceed context limit: 198000 + 8192 > 200000, decrease input length or `max_tokens` and try again",
			),
		),
	).toEqual({ limitTokens: 191808, requestedTokens: 198000 });
	expect(
		contextOverflow(
			rejected(
				"The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).",
			),
		),
	).toEqual({ limitTokens: 1048576, requestedTokens: 1200000 });
	expect(
		contextOverflow(
			rejected(
				"This endpoint's maximum context length is 131072 tokens. However, you requested about 140000 tokens (132000 of text input, 8000 in the output).",
			),
		),
	).toEqual({ limitTokens: 131072, requestedTokens: 140000 });
	expect(
		contextOverflow(
			rejected(
				"This model's maximum prompt length is 131072 but the request contains 140000 tokens.",
			),
		),
	).toEqual({ limitTokens: 131072, requestedTokens: 140000 });
	// A streamed error part, wrapped the way the model loop wraps it.
	expect(
		contextOverflow(
			new SafeApiModelFailure({
				type: "error",
				error: {
					type: "invalid_request_error",
					message: "prompt is too long: 300000 tokens > 200000 maximum",
				},
			}),
		),
	).toEqual({ limitTokens: 200000, requestedTokens: 300000 });
	expect(contextOverflow(new ContextWindowExhausted())).toEqual({});
});

it("does not mistake other rejections for a context overflow", () => {
	for (const error of [
		rejected(
			"Rate limit reached",
			{ error: { code: "rate_limit_exceeded" } },
			429,
		),
		rejected(
			"max_tokens: 64000 > 32000, which is the maximum allowed number of output tokens for this model",
		),
		rejected("Invalid API key", { error: { code: "invalid_api_key" } }, 401),
		new Error("fetch failed"),
	])
		expect(contextOverflow(error)).toBeNull();
});

it("never reports a repository guidance scan failure as a provider failure", () => {
	const error = new Error(
		"Could not safely inspect repository guidance: PermissionError: denied",
	);
	error.name = "RepositoryGuidanceUnavailable";
	const message = apiModelFailureMessage(error);
	expect(message).toContain("Could not safely inspect repository guidance");
	expect(message).toContain("not a model or provider failure");
	expect(message).not.toContain("didn't say why");
});

it("words the harness's own failures as such, redacted, and classifies them apart from providers", () => {
	const failure = new HarnessRuntimeFailure(
		"context-compaction",
		new Error(
			"Earlier history exceeds this model's context window; token=sk-live-abcdefghijklmnop",
		),
	);
	const message = apiModelFailureMessage(failure);
	expect(message).toMatch(
		/^Context compaction failed: Earlier history exceeds this model's context window; token=\[redacted\]/,
	);
	expect(message).toContain("not a model or provider failure");
	expect(message).not.toContain("sk-live");
	expect(apiTurnFailureMessage("model", failure)).toBe(message);
	expect(apiModelFailureClassification(failure)).toMatchObject({
		name: "HarnessRuntimeFailure",
		stage: "context-compaction",
		httpStatus: null,
	});
	expect(JSON.stringify(failure)).not.toContain("sk-live");
	// A runtime condition with its own wording keeps it.
	expect(
		apiModelFailureMessage(
			new HarnessRuntimeFailure(
				"context-compaction",
				new Error("Private checkpoint storage is not configured."),
			),
		),
	).toMatch(
		/^Private checkpoint storage is not configured\. .*harness configuration failure/,
	);
	expect(
		apiModelFailureMessage(
			new HarnessRuntimeFailure("step-preparation", new Error("disk full")),
		),
	).toMatch(/^Run step preparation failed: disk full/);
});

it("keeps every failure's redacted cause for the owner, not just machine failures", () => {
	// The machine detail wins when there is one.
	expect(
		failureCause(
			Object.assign(
				taggedMachineError("WorkspaceProvisionError", "vm failed"),
				{
					detail: "provider said 503 with key sk-live-abcdefghijkl",
				},
			),
		),
	).toBe("provider said 503 with key [redacted]");
	// Otherwise the error's own text and up to two inner causes.
	const inner = new TypeError("fetch failed", {
		cause: Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:443"), {
			code: "ECONNREFUSED",
			cause: new Error("too deep to include"),
		}),
	});
	expect(
		failureCause(
			new Error("Could not wake https://user:pass@vm.internal/x?token=abc", {
				cause: inner,
			}),
		),
	).toBe(
		"Error: Could not wake https://[redacted]@vm.internal/x?token=[redacted] <- TypeError: fetch failed <- Error [ECONNREFUSED]: connect ECONNREFUSED 10.0.0.1:443",
	);
	// A model failure's provider error is followed.
	expect(
		failureCause(
			Object.assign(new Error("Model failed"), {
				providerError: new Error("401 Authorization: Bearer abcdefgh12345678"),
			}),
		),
	).toBe("Error: Model failed <- Error: 401 Authorization: [redacted]");
	expect(failureCause("plain text failure")).toBe("plain text failure");
	expect(failureCause(undefined)).toBeNull();
	expect(failureCause(new Error(" y".repeat(600)))?.length).toBe(600);
});
