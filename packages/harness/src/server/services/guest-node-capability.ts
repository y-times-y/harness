import { createHash } from "node:crypto";
import type { z } from "zod";
import { privateDirectoryShell } from "../../domain/posix-command";
import { publicToolDetail } from "../../domain/tool-detail";
import type { AgentToolWorkspace } from "./agent-tool-workspace";

export const guestCapabilityPackages = {
	debugger: ["vscode-jsonrpc@9.0.3", "@vscode/debugadapter-testsupport@1.68.0"],
	browser: ["playwright-core@1.63.0"],
	language: [
		"vscode-jsonrpc@9.0.3",
		"typescript-language-server@6.0.1",
		"typescript@6.0.2",
		"web-tree-sitter@0.25.10",
		"@repomix/tree-sitter-wasms@0.1.17",
		"pyright@1.1.414",
		"vscode-languageserver-textdocument@1.0.15",
	],
} as const;
const packages = guestCapabilityPackages;

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function guestCapabilityDirectory(capability: keyof typeof packages) {
	const digest = createHash("sha256")
		.update(JSON.stringify(packages[capability]))
		.digest("hex")
		.slice(0, 16);
	return `/tmp/ytimesy-capability-${capability}-${digest}`;
}

/** Installs pinned, script-free tooling outside the repo, on demand, in the guest only. */
export function guestCapabilityCommand(
	capability: keyof typeof packages,
	source: string,
	arguments_: unknown,
	options: { onlyInstalled?: boolean; timeoutSeconds?: number } = {},
) {
	const seconds = options.timeoutSeconds ?? 55;
	if (!Number.isInteger(seconds) || seconds < 1 || seconds > 160)
		throw new Error("Invalid capability time limit.");
	const dependencies = packages[capability];
	const directory = guestCapabilityDirectory(capability);
	if (options.onlyInstalled)
		return `if test ! -L ${quote(directory)} && test -n "$(find ${quote(directory)} -maxdepth 0 -type d -user "$(id -u)" -perm 700 2>/dev/null)" && test -f ${quote(`${directory}/ready`)} && test ! -L ${quote(`${directory}/ready`)}; then timeout --kill-after=5s ${seconds}s node --input-type=module -e ${quote(source)} ${quote(directory)} ${quote(JSON.stringify(arguments_))}; else printf '%s\\n' '{"available":false}'; fi`;
	return `set -eu
${privateDirectoryShell(directory)}
(
flock -w 120 9
if ! test -f ${quote(`${directory}/ready`)}; then
  timeout --kill-after=5s 110s npm install --prefix ${quote(directory)} --ignore-scripts --no-audit --no-fund --package-lock=false ${dependencies.map(quote).join(" ")} >&2
  touch ${quote(`${directory}/ready`)}
fi
) 9>${quote(`${directory}/install.lock`)}
timeout --kill-after=5s ${seconds}s node --input-type=module -e ${quote(source)} ${quote(directory)} ${quote(JSON.stringify(arguments_))}`;
}

export async function runGuestCapability<T>(
	workspace: AgentToolWorkspace,
	capability: keyof typeof packages,
	source: string,
	arguments_: unknown,
	resultSchema: z.ZodType<T>,
	signal: AbortSignal,
	options: { onlyInstalled?: boolean } = {},
): Promise<T> {
	signal.throwIfAborted();
	const result = workspace.machines.runCapability
		? await workspace.machines.runCapability(
				workspace.vm,
				{ capability, source, arguments: arguments_, ...options },
				signal,
			)
		: await workspace.machines.exec(
				workspace.vm,
				guestCapabilityCommand(capability, source, arguments_, options),
				180_000,
			);
	signal.throwIfAborted();
	if (result.exitCode)
		throw new Error(
			`Guest ${capability} capability failed (exit ${result.exitCode}). Inspect any uncertain side effects before retrying. ${publicToolDetail(result.stderr).slice(-1200) || "Check that Node/npm and the requested server or browser are available."}`,
		);
	if (result.stdout.length > 256_000)
		throw new Error("Guest capability output exceeded its safety limit.");
	return resultSchema.parse(JSON.parse(result.stdout));
}
