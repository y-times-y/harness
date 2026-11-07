import os from "node:os";
import { parseArgs } from "node:util";
import {
	CliError,
	type ContinueOptions,
	DEFAULT_API,
	type Io,
	runContinue,
} from "./continue.ts";
import { renderError } from "./report.ts";
import { SCOPES, type Scope } from "./sessions.ts";

declare const __YTIMESY_VERSION__: string | undefined;

export const VERSION =
	typeof __YTIMESY_VERSION__ === "string" ? __YTIMESY_VERSION__ : "0.0.0-dev";

export const HELP = `ytimesy — move your local coding-agent sessions to ytimesy

Usage:
  ytimesy continue --code <code>                 Plan only: detect this session, list
                                                 scopes and folders, upload nothing.
  ytimesy continue --code <code> --scope <s>     Import: push the work to a ytimesy/
                                                 branch, upload sessions, open the chat.
  ytimesy continue --code <code> --cancel        Stop this import (the user changed
                                                 their mind); the ytimesy card stops waiting.

Scopes: session (this session, the default), project (every session of this
repository), machine (every session on this computer).

Options:
  --scope session|project|machine
  --plan                        Print the plan for --scope without importing.
  --create-repo <folder>=<name> Create a private GitHub repository for a folder
                                that has none (with your GitHub CLI login, gh),
                                and push the folder to it.
  --attach <folder>=<project>   Import a folder's sessions into an existing project
                                (id or name from the plan).
  --skip <folder>               Leave a folder out.
  --yes-untracked               Push the untracked files the plan lists.
  --no-untracked                Push tracked changes only.
  --yes-public                  Allow untracked files in a public repository.
  --secrets NAME,NAME           Upload only these .env names as project secrets.
  --no-secrets                  Upload no .env values.
  --json                        Print the result as JSON (progress goes to stderr).
  --api <url>                   ytimesy server (default ${DEFAULT_API}).
  -h, --help                    Show this help.
  -v, --version                 Print the version.

Folders are named as the plan prints them (~/code/app), by path, or by their
last segment. Re-running the same command resumes: finished steps are skipped.
The CLI reads .env and .env.local itself and never prints their values. Your
working tree, index and current branch are never changed. No telemetry.

Exit codes: 0 done (or plan printed), 1 failed, 2 usage error, 3 needs the
user's decision (the output says which flag to add).`;

function usage(message: string): never {
	throw new CliError(message, "Run `ytimesy --help` for usage.", 2);
}

export function parseContinueOptions(argv: readonly string[]): ContinueOptions {
	const { values, positionals } = parseArgs({
		args: [...argv],
		allowPositionals: true,
		strict: true,
		options: {
			code: { type: "string" },
			scope: { type: "string" },
			plan: { type: "boolean", default: false },
			json: { type: "boolean", default: false },
			api: { type: "string" },
			"create-repo": { type: "string", multiple: true, default: [] },
			attach: { type: "string", multiple: true, default: [] },
			skip: { type: "string", multiple: true, default: [] },
			"yes-untracked": { type: "boolean", default: false },
			"no-untracked": { type: "boolean", default: false },
			"yes-public": { type: "boolean", default: false },
			secrets: { type: "string" },
			"no-secrets": { type: "boolean", default: false },
			cancel: { type: "boolean", default: false },
		},
	});
	if (positionals.length) usage(`Unexpected argument: ${positionals[0]}`);
	if (!values.code)
		usage("Pass the code from ytimesy: --code YTM-XXXX-XXXX-XXXX");
	if (values.scope !== undefined && !SCOPES.includes(values.scope as Scope))
		usage(`--scope must be one of ${SCOPES.join(", ")}.`);
	if (values["yes-untracked"] && values["no-untracked"])
		usage("Pass --yes-untracked or --no-untracked, not both.");
	if (values.secrets !== undefined && values["no-secrets"])
		usage("Pass --secrets or --no-secrets, not both.");
	if (values.api) {
		try {
			const url = new URL(values.api);
			if (url.protocol !== "https:" && url.protocol !== "http:")
				throw new Error();
		} catch {
			usage(`--api must be an http(s) URL, not ${values.api}`);
		}
	}
	return {
		code: values.code,
		...(values.scope ? { scope: values.scope as Scope } : {}),
		planOnly: values.plan,
		json: values.json,
		...(values.api ? { api: values.api.replace(/\/+$/, "") } : {}),
		createRepo: values["create-repo"],
		attach: values.attach,
		skip: values.skip,
		yesUntracked: values["yes-untracked"],
		noUntracked: values["no-untracked"],
		yesPublic: values["yes-public"],
		noSecrets: values["no-secrets"],
		...(values.cancel ? { cancel: true } : {}),
		secretNames: (values.secrets ?? "")
			.split(",")
			.map((name) => name.trim())
			.filter(Boolean),
	};
}

/** Runs the CLI; returns the exit code. */
export async function main(argv: readonly string[], io: Io): Promise<number> {
	const [command, ...rest] = argv;
	const json = argv.includes("--json");
	try {
		if (
			!command ||
			command === "-h" ||
			command === "--help" ||
			command === "help"
		) {
			io.stdout(HELP);
			return 0;
		}
		if (command === "-v" || command === "--version") {
			io.stdout(VERSION);
			return 0;
		}
		if (command !== "continue") usage(`Unknown command: ${command}`);
		if (rest.includes("-h") || rest.includes("--help")) {
			io.stdout(HELP);
			return 0;
		}
		let options: ContinueOptions;
		try {
			options = parseContinueOptions(rest);
		} catch (error) {
			if (error instanceof CliError) throw error;
			usage((error as Error).message);
		}
		return await runContinue(options, io);
	} catch (error) {
		const failure =
			error instanceof CliError
				? error
				: new CliError(
						(error as Error)?.message ?? String(error),
						"Re-run the same command; finished steps are skipped. If it fails again, copy a new prompt in ytimesy.",
					);
		const report = {
			step: "error" as const,
			error: failure.message,
			next: failure.next,
		};
		io.stdout(json ? JSON.stringify(report, null, 2) : renderError(report));
		return failure.exitCode;
	}
}

export function processIo(): Io {
	return {
		env: process.env,
		cwd: process.cwd(),
		home: os.homedir(),
		stdout: (text) => process.stdout.write(`${text}\n`),
		stderr: (text) => process.stderr.write(`${text}\n`),
		version: VERSION,
	};
}
