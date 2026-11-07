import type { ModelMessage } from "ai";
import { clip } from "../../domain/clip";
import { posixShellQuoted } from "../../domain/posix-command";
import type { AgentToolWorkspace } from "./agent-tool-workspace";

/** Tools whose results carry an owned command id and a status. */
const COMMAND_TOOLS = new Set([
	"execute_command",
	"start_command",
	"continue_command",
	"read_command",
	"wait_command",
	"bash",
]);

/** Verification-shaped commands; plain reads (cat, rg, ls) are not checks. */
const CHECK =
	/\b(test|tests|vitest|jest|mocha|pytest|tox|nox|tsc|typecheck|type-check|lint|eslint|biome|ruff|mypy|pyright|flake8|clippy|check|build|compile|make|gradle|mvn|cargo|go (?:test|vet|build)|ctest|rspec|phpunit|dotnet (?:test|build)|swift (?:test|build)|verify|ci)\b/i;

const MAX_SNAPSHOT_CHARACTERS = 6_000;
const MAX_GIT_CHARACTERS = 3_500;
const MAX_COMMAND_CHARACTERS = 200;
const MAX_CHECKS = 8;

type CommandStatus = number | "running" | "interrupted";

export type CommandOutcomes = {
	checks: {
		command: string;
		status: Exclude<CommandStatus, "running">;
		stopped?: string;
	}[];
	running: { id: string; command: string }[];
};

function resultValue(output: unknown): unknown {
	if (!output || typeof output !== "object") return undefined;
	const typed = output as { type?: string; value?: unknown };
	if (typed.type === "json") return typed.value;
	if (typed.type === "text" && typeof typed.value === "string")
		try {
			return JSON.parse(typed.value);
		} catch {
			return undefined;
		}
	return undefined;
}

function clipped(command: string) {
	return clip(command.replace(/\s+/g, " ").trim(), MAX_COMMAND_CHARACTERS);
}

/** Read command outcomes from the transcript's own tool calls and results, never from model prose. */
export function commandOutcomes(
	messages: readonly ModelMessage[],
): CommandOutcomes {
	const calls = new Map<
		string,
		{ tool: string; command?: string; id?: string }
	>();
	const commandById = new Map<string, string>();
	const latest = new Map<
		string,
		{ command: string; status: CommandStatus; stopped?: string; order: number }
	>();
	let order = 0;
	const record = (
		command: string | undefined,
		id: string | undefined,
		status: unknown,
		stopped: unknown,
	) => {
		if (
			!command ||
			!(
				typeof status === "number" ||
				status === "running" ||
				status === "interrupted"
			)
		)
			return;
		latest.set(id ?? `inline:${order}`, {
			command,
			status,
			...(typeof stopped === "string" ? { stopped } : {}),
			order: order++,
		});
	};
	for (const message of messages) {
		if (typeof message.content === "string") continue;
		for (const part of message.content) {
			if (part.type === "tool-call" && COMMAND_TOOLS.has(part.toolName)) {
				const input = (part.input ?? {}) as { command?: unknown; id?: unknown };
				calls.set(part.toolCallId, {
					tool: part.toolName,
					...(typeof input.command === "string"
						? { command: input.command }
						: {}),
					...(typeof input.id === "string" ? { id: input.id } : {}),
				});
			}
			if (part.type === "tool-call" && part.toolName === "run_checks")
				calls.set(part.toolCallId, { tool: part.toolName });
			if (part.type !== "tool-result") continue;
			const call = calls.get(part.toolCallId);
			if (!call) continue;
			const value = resultValue(part.output);
			if (call.tool === "run_checks") {
				for (const result of Array.isArray(value) ? value : [])
					if (result && typeof result === "object")
						record(
							typeof result.command === "string" ? result.command : undefined,
							undefined,
							result.exitCode,
							result.stopped,
						);
				continue;
			}
			if (!value || typeof value !== "object") continue;
			const result = value as {
				id?: unknown;
				status?: unknown;
				exitCode?: unknown;
				stopped?: unknown;
			};
			const id = typeof result.id === "string" ? result.id : call.id;
			if (id && call.command) commandById.set(id, call.command);
			const command = call.command ?? (id ? commandById.get(id) : undefined);
			record(
				command,
				id,
				typeof result.status === "number" || typeof result.status === "string"
					? result.status
					: result.exitCode,
				result.stopped,
			);
		}
	}
	const ordered = [...latest.entries()].sort((a, b) => a[1].order - b[1].order);
	const checks: CommandOutcomes["checks"] = [];
	const seen = new Set<string>();
	for (let index = ordered.length - 1; index >= 0; index--) {
		const [, outcome] = ordered[index];
		if (
			outcome.status === "running" ||
			!CHECK.test(outcome.command) ||
			/^\s*(?:test|\[)\s/.test(outcome.command)
		)
			continue;
		const command = clipped(outcome.command);
		if (seen.has(command)) continue;
		seen.add(command);
		checks.unshift({
			command,
			status: outcome.status,
			...(outcome.stopped ? { stopped: outcome.stopped } : {}),
		});
		if (checks.length >= MAX_CHECKS) break;
	}
	return {
		checks,
		running: ordered.flatMap(([id, outcome]) =>
			outcome.status === "running" && !id.startsWith("inline:")
				? [{ id, command: clipped(outcome.command) }]
				: [],
		),
	};
}

export function formatStateSnapshot(input: {
	git?: string;
	outcomes: CommandOutcomes;
}) {
	const git = input.git?.trim()
		? clip(input.git.trim(), MAX_GIT_CHARACTERS, "\n[git output truncated]")
		: "Unavailable (the workspace could not be inspected now; inspect it with git directly).";
	const checks = input.outcomes.checks.length
		? input.outcomes.checks.map(
				(check) =>
					`- ${typeof check.status === "number" ? `exit ${check.status}` : check.status}${check.stopped ? ` (stopped: ${check.stopped})` : ""}: ${check.command}`,
			)
		: [
				"- None found in the transcript (no completed test, build, lint or type-check command).",
			];
	const running = input.outcomes.running.length
		? input.outcomes.running.map(
				(command) => `- ${command.id}: ${command.command}`,
			)
		: ["- None."];
	const text = [
		"## Changed files",
		git,
		"## Last completed checks (oldest first; a later edit may invalidate a pass)",
		...checks,
		"## Background commands still running (use continue_command with the id)",
		...running,
	].join("\n");
	return clip(text, MAX_SNAPSHOT_CHARACTERS, "\n[snapshot truncated]");
}

/** Status plus a diff stat against the chat's starting point (HEAD when none was recorded). */
export function gitStateCommand(cwd: string, baseRef?: string) {
	return `cd ${posixShellQuoted(cwd)} 2>/dev/null || { echo 'checkout not found'; exit 0; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo 'not a Git checkout'; exit 0; }
base=${baseRef ? posixShellQuoted(baseRef) : "HEAD"}; label=${posixShellQuoted(baseRef ? "the start of this chat" : "HEAD")}
if ! git rev-parse -q --verify "$base^{commit}" >/dev/null 2>&1; then base=HEAD; label='HEAD (chat start point unavailable)'; fi
echo "HEAD: $(git rev-parse --abbrev-ref HEAD 2>/dev/null) $(git rev-parse --short HEAD 2>/dev/null)"
echo "git status --porcelain:"
git -c core.fsmonitor=false status --porcelain=v1 -uall 2>&1 | head -n 60
echo "git diff --stat against $label:"
git -c core.fsmonitor=false diff --stat=160 "$base" 2>&1 | tail -n 40`;
}

/**
 * Deterministic post-compaction state: what the workspace and transcript say
 * now, so the model does not have to remember it.
 */
export function compactionStateSnapshot(input: {
	workspace: () => Promise<AgentToolWorkspace>;
	/** A commit-ish captured when this chat started, if one exists. */
	baseRef?: () => Promise<string | undefined>;
	/** Authoritative ids still running, when the caller tracks them outside the transcript. */
	runningIds?: () => readonly string[];
}) {
	return async (history: ModelMessage[], signal: AbortSignal) => {
		const outcomes = commandOutcomes(history);
		if (input.runningIds) {
			const ids = new Set(input.runningIds());
			const known = new Map(
				outcomes.running.map((command) => [command.id, command.command]),
			);
			outcomes.running = [...ids].map((id) => ({
				id,
				command: known.get(id) ?? "(command text is in the context archive)",
			}));
		}
		let git: string | undefined;
		try {
			signal.throwIfAborted();
			const workspace = await input.workspace();
			const base = await input.baseRef?.().catch(() => undefined);
			signal.throwIfAborted();
			const result = await workspace.machines.exec(
				workspace.vm,
				gitStateCommand(workspace.cwd, base),
				15_000,
			);
			if (!result.exitCode) git = result.stdout;
		} catch {
			if (signal.aborted) throw signal.reason;
		}
		return formatStateSnapshot({ git, outcomes });
	};
}
