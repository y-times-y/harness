import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { ApiAgentEvent } from "../domain/api-agent-event";
import { SafeApiModelFailure } from "../domain/api-turn-failure";
import {
	type HarnessVariant,
	harnessVariantFromFlags,
} from "../domain/harness-variant";
import {
	isLocalProvider,
	LOCAL_PROVIDERS,
	type LocalProviderName,
	providerFromEnvironment,
} from "./providers";
import { LOCAL_HARNESS_VARIANT, runLocalAgent } from "./run-local-agent";

export type CliIo = {
	env: Readonly<Record<string, string | undefined>>;
	cwd: string;
	/** process.platform; tests give another. */
	platform?: string;
	stdout: (text: string) => void;
	stderr: (text: string) => void;
	signal?: AbortSignal;
};

/** The harness switches a single local agent implements; the rest need the cloud product's job stack. */
const LOCAL_VARIANT_KEYS = [
	"toolSurface",
	"codeMode",
	"fetch",
	"plan",
	"rigor",
	"checks",
	"instructions",
] as const;

/** The product's local configuration with the given switches applied, or an error naming the unsupported one. */
function variantFrom(flags: string | undefined): HarnessVariant {
	if (!flags) return LOCAL_HARNESS_VARIANT;
	const keys = flags
		.split(",")
		.map((pair) => pair.split("=")[0]?.trim().split(".")[0] ?? "");
	const unsupported = keys.filter(
		(key) => !(LOCAL_VARIANT_KEYS as readonly string[]).includes(key),
	);
	if (unsupported.length)
		throw new Error(
			`--variant ${unsupported.join(", ")} is not available locally; it needs the cloud product. Available: ${LOCAL_VARIANT_KEYS.join(", ")}.`,
		);
	const parsed = harnessVariantFromFlags([flags]) as Record<string, unknown>;
	const merged: Record<string, unknown> = { ...LOCAL_HARNESS_VARIANT };
	for (const key of keys) merged[key] = parsed[key];
	return merged as HarnessVariant;
}

const USAGE = `Usage: ytimesy-harness "<task>" [options]

Runs the ytimesy coding agent on this computer, in the current directory.

Options:
  --cwd <dir>          Work in this directory (default: the current one)
  --provider <name>    ${Object.keys(LOCAL_PROVIDERS).join(", ")} (default: the first with an API key set)
  --model <id>         Model id (default: the provider's flagship)
  --base-url <url>     Send the provider's requests to this URL
  --reasoning <level>  low, medium, high, xhigh or max
  --variant <flags>    Harness switches, e.g. codeMode=primary,plan=off (${LOCAL_VARIANT_KEYS.join(", ")})
  --max-steps <n>      Stop after this many model steps
  --no-search          Turn off the provider's built-in web search (needed on some free API keys)
  --quiet              Print only the final answer
  -h, --help           Show this help

API keys come from the environment: ${Object.values(LOCAL_PROVIDERS)
	.map((provider) => provider.keyEnv)
	.join(", ")}.`;

/** The argument that says what a tool call is about, whichever tool shape the model uses. */
const DETAIL_ARGUMENTS = ["command", "cmd", "file_path", "path", "pattern"];

function describe(event: ApiAgentEvent): string | null {
	if (event.type === "tool-call") {
		const input = (event.input ?? {}) as Record<string, unknown>;
		const detail = DETAIL_ARGUMENTS.map((key) => input[key]).find(
			(value): value is string => typeof value === "string",
		);
		return `• ${event.name}${detail ? ` ${detail.split("\n")[0]?.slice(0, 100)}` : ""}`;
	}
	if (event.type === "tool-result" && event.failed)
		return `  ✗ ${event.name} failed`;
	return null;
}

function isOnPath(name: string, path: string | undefined) {
	return (path ?? "").split(":").some((directory) => {
		try {
			accessSync(join(directory, name), constants.X_OK);
			return true;
		} catch {
			return false;
		}
	});
}

/**
 * What this computer lacks for the agent's command runner, which runs
 * python3 and bash and needs process groups: null when it is ready.
 */
function unsupportedReason(io: CliIo) {
	const platform = io.platform ?? process.platform;
	if (
		platform !== "linux" &&
		platform !== "darwin" &&
		io.env.YTIMESY_HARNESS_ALLOW_PLATFORM !== "1"
	)
		return 'the agent\'s command runner needs Linux or macOS (bash, python3, process groups), and this is neither.\nNext: Run it in WSL2 or a Linux container (for example `docker run -it -v "$PWD":/work -w /work node:22 npx ytimesy-harness ...`). Set YTIMESY_HARNESS_ALLOW_PLATFORM=1 to try anyway.';
	const missing = ["python3", "bash"].filter(
		(name) => !isOnPath(name, io.env.PATH),
	);
	if (missing.length)
		return `${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not installed.\nNext: Install ${missing.join(" and ")}, then run again.`;
	return null;
}

/** What went wrong in terms of this command line, not the web app's settings page. */
function failureMessage(
	error: unknown,
	provider: LocalProviderName,
	keyEnv: string,
	providerSaid?: string,
) {
	const status =
		error instanceof SafeApiModelFailure
			? error.classification.httpStatus
			: null;
	if (status === 401 || status === 403)
		return `${provider} rejected the API key in ${keyEnv}.\nNext: Check the key (and --base-url, if you set one), then run again.`;
	if (status === 404)
		return `${provider} does not know that model.\nNext: Pass a model you can use with --model.`;
	if (status === 429)
		return `${provider} is rate limiting this key or its quota is used up.\nNext: Wait and run again, or use another key. If the key has no web search quota (common on free keys), add --no-search.`;
	return `${(error as Error).message}${providerSaid ? `\n${provider} said: ${providerSaid}` : ""}\nNext: Check the API key and model, then run again.`;
}

/** Runs the command line; returns the process exit code. */
export async function main(
	argv: readonly string[],
	io: CliIo,
): Promise<number> {
	let parsed: ReturnType<typeof parseArgs>;
	try {
		parsed = parseArgs({
			args: [...argv],
			allowPositionals: true,
			options: {
				cwd: { type: "string" },
				provider: { type: "string" },
				model: { type: "string" },
				"base-url": { type: "string" },
				reasoning: { type: "string" },
				"max-steps": { type: "string" },
				variant: { type: "string" },
				quiet: { type: "boolean" },
				"no-search": { type: "boolean" },
				help: { type: "boolean", short: "h" },
			},
		});
	} catch (error) {
		io.stderr(
			`Failed: ${(error as Error).message}\nNext: Run ytimesy-harness --help.\n`,
		);
		return 2;
	}
	const { values, positionals } = parsed;
	if (values.help) {
		io.stdout(`${USAGE}\n`);
		return 0;
	}
	const prompt = positionals.join(" ").trim();
	if (!prompt) {
		io.stderr(
			`Failed: no task given.\nNext: Run ytimesy-harness "describe what to do". See --help.\n`,
		);
		return 2;
	}
	const requested = values.provider as string | undefined;
	if (requested !== undefined && !isLocalProvider(requested)) {
		io.stderr(
			`Failed: unknown provider "${requested}".\nNext: Use one of ${Object.keys(LOCAL_PROVIDERS).join(", ")}.\n`,
		);
		return 2;
	}
	const provider: LocalProviderName | null =
		requested ?? providerFromEnvironment(io.env);
	const keyEnv = provider ? LOCAL_PROVIDERS[provider].keyEnv : null;
	const apiKey = keyEnv ? io.env[keyEnv] : undefined;
	if (!provider || !apiKey) {
		io.stderr(
			`Failed: no API key found${provider ? ` for ${provider} (${keyEnv})` : ""}.\nNext: Set ${Object.values(
				LOCAL_PROVIDERS,
			)
				.map((candidate) => candidate.keyEnv)
				.join(" or ")} and run again.\n`,
		);
		return 2;
	}
	const maxSteps = values["max-steps"]
		? Number(values["max-steps"])
		: undefined;
	if (maxSteps !== undefined && !(Number.isInteger(maxSteps) && maxSteps > 0)) {
		io.stderr("Failed: --max-steps must be a positive whole number.\n");
		return 2;
	}
	const unsupported = unsupportedReason(io);
	if (unsupported) {
		io.stderr(`Failed: ${unsupported}\n`);
		return 2;
	}
	let variant: HarnessVariant;
	try {
		variant = variantFrom(values.variant as string | undefined);
	} catch (error) {
		io.stderr(`Failed: ${(error as Error).message}\n`);
		return 2;
	}
	const quiet = values.quiet === true;
	if (!quiet && (io.platform ?? process.platform) === "darwin")
		io.stderr(
			"Note: macOS support is new and untested; please report problems.\n",
		);
	if (!quiet && !isOnPath("tmux", io.env.PATH))
		io.stderr(
			"Note: tmux is not installed, so long-running background commands are unavailable.\n",
		);
	let providerSaid: string | undefined;
	try {
		const result = await runLocalAgent({
			prompt,
			cwd: (values.cwd as string | undefined) ?? io.cwd,
			model: {
				provider,
				apiKey,
				modelId: values.model as string | undefined,
				baseUrl: values["base-url"] as string | undefined,
				reasoning: values.reasoning as string | undefined,
				onProviderError: (message) => {
					providerSaid = message;
				},
			},
			maxSteps,
			variant,
			...(values["no-search"] ? { webSearch: false } : {}),
			signal: io.signal,
			onEvent: (event) => {
				const line = quiet ? null : describe(event);
				if (line) io.stderr(`${line}\n`);
			},
		});
		io.stdout(`${result.answer.trimEnd()}\n`);
		return 0;
	} catch (error) {
		io.stderr(
			`Failed: ${failureMessage(error, provider, keyEnv ?? "", providerSaid)}\n`,
		);
		return 1;
	}
}
