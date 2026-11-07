import { randomUUID } from "node:crypto";
import { type ToolSet, tool } from "ai";
import { Effect } from "effect";
import { z } from "zod";
import { checkExecutionGroups } from "../../domain/check-execution-groups";
import type { WorkspaceId } from "../../domain/ids";
import { sourceEvidenceContentsMatch } from "../../domain/project-source-evidence";
import type { AgentMachines } from "./agent-machines";
import {
	type AgentOutput,
	type agentOutputArtifacts,
	COMMAND_MAX_CHARACTERS,
	type verificationReceiptSchema,
} from "./agent-output-artifacts";
import {
	type AgentToolWorkspaceInput,
	resolveToolWorkspace,
} from "./agent-tool-workspace";
import {
	backgroundCommandMaxSeconds,
	backgroundCommandScope,
	scopedShellCommand,
	stopApiCommand,
} from "./api-command-scope";
import {
	COMMAND_WAIT_DEFAULT_SECONDS,
	COMMAND_WAIT_MAX_SECONDS,
	COMMAND_WAIT_STALL_SECONDS,
	waitForCommand,
} from "./command-wait";
import { inspectProjectSourceEvidence } from "./project-source-evidence";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const jobId = z.string().uuid();
type CheckResult = AgentOutput & {
	command: string;
	passed: boolean;
	verification?: z.infer<typeof verificationReceiptSchema>;
	outputView?: "summary";
};

/** Formatting must finish successfully before any checks observe the edited checkout. */
export async function verifyPatchedCheckout(input: {
	signal: AbortSignal;
	format?: () => Promise<
		Awaited<ReturnType<ReturnType<typeof agentOutputArtifacts>["capture"]>>
	>;
	check: () => Promise<unknown>;
	preflight?: () => Promise<unknown>;
}) {
	input.signal.throwIfAborted();
	const formatting = input.format ? await input.format() : null;
	if (formatting && (formatting.exitCode !== 0 || formatting.stopped !== null))
		return { formatting, checks: null };
	input.signal.throwIfAborted();
	const preflightChecks = input.preflight ? await input.preflight() : undefined;
	if (input.preflight) {
		const receipts = z
			.array(
				z.object({
					exitCode: z.number().int(),
					stopped: z.enum(["timeout", "output_limit"]).nullable(),
				}),
			)
			.min(1)
			.parse(preflightChecks);
		if (
			receipts.some(
				(receipt) => receipt.exitCode !== 0 || receipt.stopped !== null,
			)
		)
			return { formatting, preflightChecks, checks: null };
	}
	input.signal.throwIfAborted();
	return {
		formatting,
		...(input.preflight ? { preflightChecks } : {}),
		checks: await input.check(),
	};
}
/** The tmux socket every runtime command runs on, one session per command. */
export const COMMAND_TMUX_SOCKET = "ytimesy-api";

/** The tmux session running command `id`. */
export const commandSessionName = (id: string) =>
	`ytimesy-${id.replaceAll("-", "")}`;

/** The exit status recorded for a command that was stopped (as for Ctrl-C). */
export const STOPPED_COMMAND_STATUS = 130;

/** Where a session's commands keep `<id>.output`, `<id>.status` and `<id>.sh`. */
export const commandRoot = (sessionId: string) =>
	`/tmp/ytimesy-api-commands/${sessionId.replaceAll(/[^a-zA-Z0-9-]/g, "").slice(0, 64)}`;

const COMPLETIONS_SCRIPT = `import json, os, pathlib, stat, subprocess, sys
root = pathlib.Path(sys.argv[1])
if root.is_symlink():
    raise ValueError('Command root cannot be a symlink')
results = []
for identifier in json.loads(sys.argv[2]):
    path = root / (identifier + '.status')
    if not path.exists():
        active = subprocess.run(['tmux', '-L', '${COMMAND_TMUX_SOCKET}', 'has-session', '-t', 'ytimesy-' + identifier.replace('-', '')], capture_output=True).returncode == 0
        if not active:
            results.append({'id': identifier, 'status': 'interrupted', 'stopped': None})
        continue
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, encoding='utf-8') as handle:
        if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
            raise ValueError('Status must be a regular file')
        raw = handle.read(1000001).strip()
    result = json.loads(raw) if raw.startswith('{') else {'exitCode': int(raw), 'stopped': None}
    results.append({'id': identifier, 'status': result['exitCode'], 'stopped': result['stopped']})
print(json.dumps(results))`;

/** One bounded guest observation at a runtime safe point; no model polling or arbitrary paths. */
export async function completedAgentCommands(
	input: AgentToolWorkspaceInput & {
		sessionId: string;
		ids: readonly string[];
		signal: AbortSignal;
	},
) {
	input.signal.throwIfAborted();
	const ids = z.array(jobId).max(20).parse(input.ids);
	if (!ids.length) return [];
	const { machines, vm } = await resolveToolWorkspace(input);
	const result = await machines.exec(
		vm,
		`python3 -c ${quote(COMPLETIONS_SCRIPT)} ${quote(commandRoot(input.sessionId))} ${quote(JSON.stringify(ids))}`,
		15_000,
	);
	if (result.exitCode)
		throw new Error("Could not observe owned command completion safely.");
	return z
		.array(
			z.object({
				id: jobId,
				status: z.union([z.number().int(), z.literal("interrupted")]),
				stopped: z.enum(["timeout", "output_limit"]).nullable(),
			}),
		)
		.parse(JSON.parse(result.stdout));
}
const WRITE_JOB_SCRIPT =
	"import base64,os,sys; fd=os.open(sys.argv[1],os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600); os.write(fd,base64.b64decode(sys.argv[2])); os.close(fd)";

const READ_COMMAND_SCRIPT = `import json, os, pathlib, stat, subprocess, sys, time
output, status, session, start, seconds = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), int(sys.argv[5])
if not 0 <= start <= 100000000 or not 0 <= seconds <= 55:
    raise ValueError('Command page or wait is outside the supported range')
deadline = time.monotonic() + seconds
while not pathlib.Path(status).exists() and time.monotonic() < deadline:
    if subprocess.run(['tmux', '-L', '${COMMAND_TMUX_SOCKET}', 'has-session', '-t', session], capture_output=True).returncode:
        break
    time.sleep(0.25)
state = 'interrupted'
stopped = None
if pathlib.Path(status).exists():
    descriptor = os.open(status, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, encoding='utf-8') as handle:
        if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
            raise ValueError('Status must be a regular file')
        raw = handle.read(1000001).strip()
        if raw.startswith('{'):
            result = json.loads(raw)
            state, stopped = result['exitCode'], result['stopped']
        else:
            state = int(raw)
elif subprocess.run(['tmux', '-L', '${COMMAND_TMUX_SOCKET}', 'has-session', '-t', session], capture_output=True).returncode == 0:
    state = 'running'
if state != 'running':
    # A background command the agent saw finish needs no completion notice (background-command-notices.ts).
    base = status[:-len('.status')]
    if os.path.exists(base + '.background'):
        try:
            os.close(os.open(base + '.notified', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600))
            pathlib.Path(base + '.notified').write_text('agent')
        except FileExistsError:
            pass
if len(sys.argv) > 6 and pathlib.Path(sys.argv[6]).exists():
    output = sys.argv[6]
if seconds > 0 and state == 'running' and not (len(sys.argv)>7 and sys.argv[7]=='live'):
    print(json.dumps({'status': state, 'stopped': stopped, 'stdout': '', 'start': start, 'nextStart': start, 'outputDeferred': True, 'outputBytes': os.path.getsize(output) if os.path.exists(output) else 0}))
    sys.exit(0)
descriptor = os.open(output, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
with os.fdopen(descriptor, encoding='utf-8', errors='replace') as handle:
    if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
        raise ValueError('Output must be a regular file')
    handle.read(start)
    text = handle.read(32001)
# While running, the cursor marks the current end so the next read returns only newer output.
print(json.dumps({'status': state, 'stopped': stopped, 'stdout': text[:32000], 'start': start, 'nextStart': start + 32000 if len(text) > 32000 else start + len(text) if state == 'running' else None}, ensure_ascii=False))`;

export function apiAgentCommandTools(
	input: AgentToolWorkspaceInput & {
		sessionId: string;
		/** The chat's owner: signs a background command's exit callback. */
		userId?: string;
		/**
		 * Tells the product's edge when a background command exits, so its chat
		 * wakes within seconds. Left out outside the cloud product.
		 */
		prepareExitCallback?: (
			machines: Pick<AgentMachines, "exec" | "writeTextFile">,
			vm: WorkspaceId,
			callback: {
				userId: string;
				sessionId: string;
				commandId: string;
				root: string;
			},
		) => Promise<string>;
		turnId: string;
		readOnly: boolean;
		signal: AbortSignal;
		once: (id: string, run: () => Promise<unknown>) => Promise<unknown>;
		output?: ReturnType<typeof agentOutputArtifacts>;
		/** Latest epoch ms a command wait may end: the step budget or turn deadline minus a margin. */
		waitDeadlineAt?: number;
	},
): ToolSet {
	const { signal, once } = input;
	const root = commandRoot(input.sessionId);
	const paths = (id: string) => ({
		output: `${root}/${id}.output`,
		status: `${root}/${id}.status`,
		session: commandSessionName(id),
	});
	const readCommand = async (id: string, start = 0, seconds = 0) => {
		signal.throwIfAborted();
		jobId.parse(id);
		const { machines, vm } = await resolveToolWorkspace(input);
		const path = paths(id);
		const result = await machines.exec(
			vm,
			`python3 -c ${quote(READ_COMMAND_SCRIPT)} ${quote(path.output)} ${quote(path.status)} ${quote(path.session)} ${start} ${seconds}${input.output ? ` ${quote(`${input.output.directory}/${id}.stdout`)}` : ""}`,
			(seconds + 5) * 1000,
		);
		if (result.exitCode)
			throw new Error("Command was not found in this agent session.");
		return JSON.parse(result.stdout) as {
			status: number | "running" | "interrupted";
			stopped?: "timeout" | "output_limit" | null;
			stdout: string;
			start: number;
			nextStart: number | null;
			outputBytes?: number;
		};
	};
	const launchCommand = async (
		command: string,
		maxSeconds: number,
		observeSeconds?: number,
		/** A background command: its own scope (not stopped with the turn), the long cap, a notice when it exits. */
		background?: { label: string },
	) => {
		signal.throwIfAborted();
		const { machines, vm, cwd } = await resolveToolWorkspace(input);
		const id = randomUUID();
		const path = paths(id);
		if (background) maxSeconds = backgroundCommandMaxSeconds();
		const scoped = scopedShellCommand({
			turnId: background
				? backgroundCommandScope(input.sessionId)
				: input.turnId,
			cwd,
			command,
			seconds: maxSeconds,
			commandId: id,
		});
		// A background command tells the edge when it exits, so its chat wakes
		// within seconds; without a callback the cron's watcher still does.
		const exitCallback =
			background && input.userId && input.prepareExitCallback
				? await input.prepareExitCallback(machines, vm, {
						userId: input.userId,
						sessionId: input.sessionId,
						commandId: id,
						root,
					})
				: "";
		const job = `${
			input.output
				? `${input.output.captureCommand(scoped, maxSeconds, id, true)} >${quote(`${path.status}.pending`)} && mv ${quote(`${path.status}.pending`)} ${quote(path.status)}`
				: `${scoped} >${quote(path.output)} 2>&1; printf '%s\\n' "$?" >${quote(path.status)}`
		}${exitCallback}`;
		const observation =
			observeSeconds === undefined
				? ""
				: ` && python3 -c ${quote(READ_COMMAND_SCRIPT)} ${quote(path.output)} ${quote(path.status)} ${quote(path.session)} 0 ${observeSeconds} ${quote(input.output ? `${input.output.directory}/${id}.stdout` : path.output)} live`;
		// tmux rejects commands over ~16 KB ("command too long"), so the job is
		// written to a script file first and tmux only runs that file.
		const script = `${root}/${id}.sh`;
		const marker = background
			? ` && printf '%s' ${quote(JSON.stringify({ label: background.label, startedAt: Date.now() }))} >${quote(`${root}/${id}.background`)}`
			: "";
		const result = await machines.exec(
			vm,
			`mkdir -p ${quote(root)} && python3 -c ${quote(WRITE_JOB_SCRIPT)} ${quote(script)} ${Buffer.from(job, "utf8").toString("base64")} && : >${quote(path.output)}${marker} && tmux -L ${COMMAND_TMUX_SOCKET} new-session -d -s ${quote(path.session)} bash ${quote(script)}${observation}`,
			15000 + (observeSeconds ?? 0) * 1000,
		);
		if (result.exitCode)
			throw new Error(
				"Could not start or observe command. Inspect owned command state before retrying uncertain execution.",
			);
		return {
			id,
			...(observeSeconds === undefined
				? { status: "running" }
				: JSON.parse(result.stdout)),
			...(input.output ? { reference: id } : {}),
			...(background ? { background: true } : {}),
		};
	};
	const tools: ToolSet = {
		read_command: tool({
			description:
				"Read status and a complete-output page of a command owned by this session. Follow nextStart to retrieve earlier/later evidence; a null cursor while running is only the current end, not proof of completion.",
			inputSchema: z.object({
				id: jobId,
				start: z.number().int().min(0).max(100_000_000).default(0),
			}),
			execute: ({ id, start = 0 }) => readCommand(id, start),
		}),
	};
	if (input.readOnly) return tools;
	if (input.output) {
		const output = input.output;
		tools.bash = tool({
			description:
				"Run a shell command in this task's isolated repository: use rg, Git inspection and project CLIs directly. Commands are bounded to 30 seconds; use start_command and wait_command for longer work. Do not launch detached work or publish without authorization.",
			inputSchema: z.object({
				command: z.string().min(1).max(COMMAND_MAX_CHARACTERS),
			}),
			execute: ({ command }, options) =>
				input.once(options.toolCallId, async () => {
					input.signal.throwIfAborted();
					const { cwd } = await resolveToolWorkspace(input);
					input.signal.throwIfAborted();
					return output.capture(
						scopedShellCommand({
							turnId: input.turnId,
							cwd,
							command,
							seconds: 30,
						}),
						30,
					);
				}),
		});
		const checksSchema = z.object({
			commands: z.array(z.string().min(1).max(16_000)).min(1).max(8),
			parallel: z
				.boolean()
				.default(false)
				.describe("Shorthand for independent checks when groups is omitted."),
			groups: z
				.array(z.array(z.number().int().min(0).max(7)).min(1).max(2))
				.min(1)
				.max(8)
				.optional()
				.describe(
					"Ordered groups of up to two independent command indices. Includes every command exactly once; overrides parallel.",
				),
			maxSeconds: z.number().int().min(1).max(120).default(120),
			sourcePaths: z
				.array(z.string().min(1).max(2048))
				.min(1)
				.max(8)
				.optional(),
			outputView: z.enum(["full", "summary"]).default("summary"),
		});
		tools.run_checks = tool({
			description:
				"Run required checks on a stable formatted tree; preserve every actual exit and stop reason. sourcePaths binds up to eight declared files to before/after hashes; changed or unavailable sources make passed:false even with exit 0. Cover all changed files across batches. Default outputView:summary returns bounded tails and omitted-output recovery pointers, not complete logs; retrieve full output for failures, warnings or uncertainty. outputView:full returns the first complete-output page. parallel:true overlaps at most two genuinely independent checks; no edits or shared generated-file writes during checks. No dropped checks or invented success.",
			inputSchema: checksSchema,
			// The SDK keeps execution events intact; only model history uses this view.
			toModelOutput: ({ output }) => ({
				type: "json",
				value: output.map((result: CheckResult) => {
					if (
						result.outputView !== "summary" ||
						!result.passed ||
						!result.verification?.sourcesStable
					)
						return result;
					return {
						...result,
						verification: {
							sourcesStable: true,
							sourcePaths: result.verification.after.sources.map(
								(source) => source.path,
							),
							fullEvidence: {
								reference: result.reference,
								stream: "stdout",
								start: 0,
								view: "page",
							},
						},
					};
				}),
			}),
			execute: (arguments_, options) =>
				once(options.toolCallId, async () => {
					const {
						commands,
						maxSeconds,
						parallel,
						groups,
						sourcePaths,
						outputView,
					} = checksSchema.parse(arguments_);
					const executionGroups = checkExecutionGroups(
						commands.length,
						groups,
						parallel,
					);
					signal.throwIfAborted();
					const workspace = await resolveToolWorkspace(input);
					const { cwd } = workspace;
					const before = sourcePaths
						? await inspectProjectSourceEvidence(workspace, sourcePaths, true)
						: null;
					const results = [];
					for (const group of executionGroups)
						results.push(
							...(await Effect.runPromise(
								Effect.forEach(
									group.map((index) => commands[index]),
									(command) =>
										Effect.promise(async () => {
											signal.throwIfAborted();
											const result = await output.capture(
												scopedShellCommand({
													turnId: input.turnId,
													cwd,
													command,
													seconds: maxSeconds,
												}),
												maxSeconds + 5,
											);
											return {
												command,
												...result,
												passed:
													result.exitCode === 0 && result.stopped === null,
											};
										}),
									{ concurrency: 2 },
								),
							)),
						);
					const after =
						before && sourcePaths
							? await inspectProjectSourceEvidence(workspace, sourcePaths, true)
							: null;
					return Promise.all(
						results.map(async (result) => {
							const verification =
								before && after
									? {
											command: result.command,
											cwd,
											before,
											after,
											sourcesStable: sourceEvidenceContentsMatch(before, after),
										}
									: null;
							if (verification)
								await output.recordVerification(result.reference, verification);
							const summaries =
								outputView === "summary" && result.passed
									? await Promise.all(
											(["stdout", "stderr"] as const).map((stream) =>
												output.read({
													reference: result.reference,
													stream,
													view: "summary",
												}),
											),
										)
									: null;
							return {
								...result,
								...(verification
									? {
											verification,
											passed: result.passed && verification.sourcesStable,
										}
									: {}),
								...(summaries
									? {
											stdout: summaries[0].content,
											stderr: summaries[1].content,
											outputView: "summary",
											outputSummaries: summaries.map(
												({
													content: _content,
													verification: _verification,
													...metadata
												}) => metadata,
											),
											stdoutNextStart: summaries[0].omittedCharacters
												? 0
												: null,
											stderrNextStart: summaries[1].omittedCharacters
												? 0
												: null,
										}
									: {}),
							};
						}),
					);
				}),
		});
	}
	tools.wait_command = tool({
		description:
			"Wait for an owned command to finish without repeated model polling. Bounded to 55 seconds; if still running, output is deferred with an unchanged cursor, not discarded. Use read_command to inspect live progress if needed. Inspect completion status and all output pages before claiming checks passed. Does not start or stop commands.",
		inputSchema: z.object({
			id: jobId,
			start: z.number().int().min(0).max(100_000_000).default(0),
			seconds: z.number().int().min(1).max(55).default(10),
		}),
		execute: ({ id, start = 0, seconds = 10 }) =>
			readCommand(id, start, seconds),
	});
	tools.start_command = tool({
		description:
			"Start a repository command that may take several minutes. Returns an ID; use read_command to inspect output and completion. Bounded to ten minutes.",
		inputSchema: z.object({
			command: z.string().min(1).max(COMMAND_MAX_CHARACTERS),
			maxSeconds: z.number().int().min(30).max(600).default(300),
		}),
		execute: ({ command, maxSeconds = 300 }, options) =>
			once(options.toolCallId, () => launchCommand(command, maxSeconds)),
	});
	tools.stop_command = tool({
		description: "Stop a long-running command owned by this agent session.",
		inputSchema: z.object({ id: jobId }),
		execute: ({ id }, options) =>
			once(options.toolCallId, async () => {
				signal.throwIfAborted();
				jobId.parse(id);
				const workspace = await resolveToolWorkspace(input);
				const { machines, vm } = workspace;
				const path = paths(id);
				const ownership = await machines.exec(
					vm,
					`test -f ${quote(path.output)}`,
					10000,
				);
				if (ownership.exitCode)
					throw new Error("Command was not found in this agent session.");
				await stopApiCommand(workspace, input.turnId, id);
				await stopApiCommand(
					workspace,
					backgroundCommandScope(input.sessionId),
					id,
				);
				// Stopped by the agent: no completion notice.
				const result = await machines.exec(
					vm,
					`test -f ${quote(path.output)} || exit 2; test -f ${quote(`${root}/${id}.notified`)} || printf agent >${quote(`${root}/${id}.notified`)}; tmux -L ${COMMAND_TMUX_SOCKET} kill-session -t ${quote(path.session)} 2>/dev/null || true; test -f ${quote(path.status)} || printf '${STOPPED_COMMAND_STATUS}\\n' >${quote(path.status)}`,
					15_000,
				);
				if (result.exitCode)
					throw new Error("Command was not found in this agent session.");
				return { id, status: "stopped" };
			}),
	});
	tools.execute_command = tool({
		description:
			"Run a repository shell command (rg, Git, project CLIs). Returns output and actual status if finished, or an owned id if still running after yieldSeconds. Continue the SAME command with continue_command, which waits for it to finish; never restart just because it yielded. Bounded to ten minutes. No detached work, credentials, or publication without authorization.",
		inputSchema: z.object({
			command: z.string().min(1).max(COMMAND_MAX_CHARACTERS),
			maxSeconds: z.number().int().min(30).max(600).default(300),
			// Returns as soon as the command finishes; a one-second default made
			// every slower check cost an extra continue_command model step.
			yieldSeconds: z.number().int().min(0).max(30).default(10),
		}),
		// `background` is internal (the lean surfaces' background option); the schema drops it from model calls.
		execute: async (arguments_, options) => {
			const { command, maxSeconds = 300, yieldSeconds = 10 } = arguments_;
			const { background } = arguments_ as { background?: { label: string } };
			return once(options.toolCallId, () =>
				launchCommand(
					command,
					maxSeconds,
					yieldSeconds,
					background?.label ? { label: background.label } : undefined,
				),
			);
		},
	});
	tools.continue_command = tool({
		description:
			"Continue an owned command: optionally send literal stdin text and/or EOF, then wait for it and read output at start. The wait ends as soon as the command exits, or after seconds (default 300, or 10 after input), or early if output stalls for 3 minutes; then it returns output and status. Prefer one long wait over repeated short checks; pass a small seconds only to peek at progress. While running, nextStart is the current end: pass it as start to read only newer output. Does not restart it. Read all continuation pages and actual exit/stop status before claiming success. Never send credentials. Use stop_command to cancel a hung or runaway command.",
		inputSchema: z.object({
			id: jobId,
			chars: z
				.string()
				.max(8192)
				.refine(
					(text) =>
						[...text].every((character) => {
							const code = character.charCodeAt(0);
							return (code >= 32 && code !== 127) || code === 9 || code === 10;
						}),
					"Use literal text, tabs and newlines; stop_command cancels.",
				)
				.optional(),
			eof: z.boolean().default(false),
			start: z.number().int().min(0).max(100000000).default(0),
			seconds: z.number().int().min(0).max(COMMAND_WAIT_MAX_SECONDS).optional(),
		}),
		execute: async (
			{ id, chars, eof = false, start = 0, seconds },
			options,
		) => {
			jobId.parse(id);
			if (chars || eof) {
				await once(options.toolCallId, async () => {
					signal.throwIfAborted();
					const { machines, vm } = await resolveToolWorkspace(input);
					const path = paths(id);
					const result = await machines.exec(
						vm,
						`test -f ${quote(path.output)} && ! test -f ${quote(path.status)} && tmux -L ${COMMAND_TMUX_SOCKET} has-session -t ${quote(path.session)} && ${chars ? `tmux -L ${COMMAND_TMUX_SOCKET} send-keys -t ${quote(path.session)} -l -- ${quote(chars)}` : "true"}${eof ? ` && tmux -L ${COMMAND_TMUX_SOCKET} send-keys -t ${quote(path.session)} C-d` : ""}`,
						15000,
					);
					if (result.exitCode)
						throw new Error(
							"Command is not running in this session; input was not confirmed. Inspect status before retrying.",
						);
					return { id, inputSent: true };
				});
			}
			const waitSeconds =
				seconds ?? (chars || eof ? 10 : COMMAND_WAIT_DEFAULT_SECONDS);
			const wait = waitSeconds
				? await waitForCommand({
						observe: (chunk) => readCommand(id, start, chunk),
						seconds: waitSeconds,
						signal,
						deadlineAt: input.waitDeadlineAt,
					})
				: { reason: "elapsed" as const, waitedSeconds: 0 };
			const page = await readCommand(id, start);
			if (page.status !== "running") return { id, ...page };
			const { outputBytes: _bytes, ...running } = page;
			return {
				id,
				...running,
				waitedSeconds: wait.waitedSeconds,
				...(wait.reason === "stalled"
					? {
							note: `No new output for ${COMMAND_WAIT_STALL_SECONDS} s; it may be hung or waiting for input. Continue waiting, send input, or stop_command.`,
						}
					: wait.reason === "deadline"
						? {
								note: "Wait cut short by the time left in this step; continue_command again to keep waiting.",
							}
						: {}),
			};
		},
	});
	return tools;
}
