import { randomUUID } from "node:crypto";
import type { Tool, ToolSet } from "ai";
import { backgroundCommandLabel } from "../../domain/background-command";
import { MEMORY_DIRECTORY } from "../../domain/memory-repo";
import { posixShellQuoted as quote } from "../../domain/posix-command";
import { agentOutputDirectory } from "./agent-output-artifacts";
import type { AgentToolWorkspace } from "./agent-tool-workspace";
import { STOPPED_COMMAND_STATUS } from "./api-agent-command-tools";
import { COMMAND_WAIT_MAX_SECONDS } from "./command-wait";
import { LeanEditError } from "./lean-edit";
import {
	commandTruncationNote,
	keepHead,
	keepTail,
	LEAN_MAX_BYTES,
} from "./lean-output";
import { READ_SCRIPT, TAIL_SCRIPT, WRITE_SCRIPT } from "./lean-scripts";
import { toolRequestFingerprint } from "./tool-execution-identity";

/**
 * The lean builder surfaces (docs/builder-tool-surface.md): each model family
 * sees the tool names and argument shapes of its own vendor harness (or our own
 * core four), over one shared engine. Commands go through the runtime's
 * execute/continue/stop tools (same runner, limits, journal and background
 * tracking); edits through one exact-then-fuzzy matcher; every output through
 * one limit (2000 lines / 50 KB, head for reads, tail for commands, with the
 * full command output kept in a file).
 */

export type LeanSurfaceContext = {
	workspace: () => Promise<AgentToolWorkspace>;
	sessionId: string;
	turnId: string;
	toolCallPrefix?: string;
	signal: AbortSignal;
	/** Runs a write once per tool call; a retried step gets the recorded outcome (durable in the cloud product). */
	once: (
		requestId: string,
		fingerprint: string,
		run: () => Promise<unknown>,
	) => Promise<unknown>;
	/** Memoizes per-turn state: helper installation, command output cursors (api-turn passes turnMemo). */
	memo?: <T>(key: string, load: () => Promise<T>) => Promise<T>;
	/** Installs the workspace commands (lean-helpers.ts) on the machine. */
	installHelpers: (workspace: AgentToolWorkspace) => Promise<void>;
	/**
	 * Stores the screenshots and recordings the agent made with ytimesy-browser
	 * (agent-captures.ts) after a command that may have made one, and returns a
	 * note for the command's result ("" when there were none). Root chats only.
	 */
	collectCaptures?: (
		workspace: AgentToolWorkspace,
		toolCallId: string,
	) => Promise<string>;
};

/** Commands after which ytimesy-browser captures may be waiting: the browser command itself, or a wait on a background one. */
const CAPTURING_COMMAND = /\bytimesy-(?:browser|job)\b/;

type ExecuteOptions = Parameters<NonNullable<Tool["execute"]>>[1];
type CommandPage = {
	id: string;
	status: number | "running" | "interrupted";
	stopped?: "timeout" | "output_limit" | null;
	stdout?: string;
	start?: number;
	nextStart?: number | null;
	note?: string;
};

export type LeanCommandResult = {
	/** The runtime's command id; background tracking reads `id` and `status: "running"`. */
	id: string;
	status: number | "running" | "interrupted";
	stopped?: "timeout" | "output_limit" | null;
	command: string;
	output: string;
	outputPath: string;
	truncationNote?: string;
	wallSeconds: number;
	note?: string;
	/** Started with the background option: runs on after the turn and notifies its agent when it exits. */
	background?: true;
};

type FileRead =
	| { path: string; missing: true }
	| { path: string; directory: true; entries: string[] }
	| { path: string; binary: true; bytes: number }
	| { path: string; error: string }
	| {
			path: string;
			image: string;
			base64: string;
			bytes: number;
	  }
	| {
			path: string;
			lines: string[];
			totalLines: number;
			startLine: number;
			cut: boolean;
	  };

/** The longest a foreground lean command runs, and the longest a call waits for one. */
export const LEAN_COMMAND_MAX_SECONDS = 600;
/** A foreground command's default time limit. */
export const LEAN_COMMAND_DEFAULT_SECONDS = 120;
/** The longest a command call waits before returning a still-running command's id. */
export const LEAN_YIELD_MAX_SECONDS = 30;
/** Workspace exec timeout for the engine's own file and search helpers. */
const HELPER_EXEC_MS = 30_000;
/** Where a write may land: the repository (the workspace cwd) and the memory repo. */
const writableRoots = (cwd: string) => [cwd, MEMORY_DIRECTORY];

/** The shared engine: one command runner, one file reader/writer, one edit matcher, one output limit. */
export function leanEngine(base: ToolSet, context: LeanSurfaceContext) {
	const { signal } = context;
	const outputDirectory = agentOutputDirectory(context.sessionId);
	const outputPath = (id: string) => `${outputDirectory}/${id}.stdout`;
	let helpers: Promise<void> | undefined;
	/**
	 * Where each command's output continues from, for the write_stdin tool
	 * (output since the last read). Kept in the turn memo so every step of
	 * the turn in this isolate shares it and it ends with the turn.
	 */
	let cursors: Promise<Map<string, number>> | undefined;
	const commandCursors = () => {
		cursors ??= context.memo
			? context.memo("lean-command-cursors", async () => new Map())
			: Promise.resolve(new Map());
		return cursors;
	};
	/** The workspace, with the helper commands installed (best effort: a failure only costs the helpers). */
	const ready = async () => {
		signal.throwIfAborted();
		const workspace = await context.workspace();
		const install = () => context.installHelpers(workspace);
		helpers ??= (
			context.memo
				? context.memo(`lean-helpers:${workspace.vm}`, install)
				: install()
		).catch((error: unknown) => {
			console.warn("Lean workspace commands were not installed.", error);
		});
		await helpers;
		return workspace;
	};
	const once = (
		name: string,
		args: unknown,
		options: ExecuteOptions,
		run: () => Promise<unknown>,
	) => {
		const requestId = `${context.turnId}:${context.toolCallPrefix ?? ""}${options.toolCallId}`;
		const fingerprint = toolRequestFingerprint(name, args);
		return context.once(requestId, fingerprint, run);
	};
	const call = async (name: string, args: unknown, options: ExecuteOptions) => {
		const execute = base[name]?.execute;
		if (!execute)
			throw new Error(`The command runner (${name}) is unavailable.`);
		return (await execute(args as never, options)) as CommandPage;
	};

	/** Shows a page's output (or the file's tail from `from`) within the limit, tail kept. */
	async function shown(
		workspace: AgentToolWorkspace,
		id: string,
		page: CommandPage,
		from: number,
		maxBytes: number,
	) {
		const text = page.stdout ?? "";
		const complete =
			page.start === from &&
			(page.status === "running"
				? text.length < 32_000
				: page.nextStart === null || page.nextStart === undefined);
		if (complete) {
			const truncation = keepTail(text, { maxBytes });
			return {
				output: truncation.content,
				end:
					page.status === "running" ? (page.nextStart ?? undefined) : undefined,
				note: truncation.truncated
					? commandTruncationNote(truncation, outputPath(id))
					: undefined,
			};
		}
		const result = await workspace.machines.exec(
			workspace.vm,
			`python3 -c ${quote(TAIL_SCRIPT)} ${quote(outputPath(id))} ${from} ${maxBytes + 1}`,
			HELPER_EXEC_MS,
		);
		if (result.exitCode)
			return {
				output: text,
				end: page.nextStart ?? undefined,
				note: `[Output may be incomplete. Full output: ${outputPath(id)}]`,
			};
		const tail = JSON.parse(result.stdout) as {
			text: string;
			cut: boolean;
			lines: number;
			end: number;
		};
		const truncation = keepTail(tail.text, { maxBytes });
		const shownLines = truncation.lastLine - truncation.firstLine + 1;
		return {
			output: truncation.content,
			end: page.status === "running" ? tail.end : undefined,
			note:
				truncation.truncated || tail.cut
					? commandTruncationNote(
							{
								firstLine: tail.lines - shownLines + 1,
								lastLine: tail.lines,
								totalLines: tail.lines,
							},
							outputPath(id),
						)
					: undefined,
		};
	}

	async function settle(
		workspace: AgentToolWorkspace,
		command: string,
		page: CommandPage,
		from: number,
		started: number,
		maxBytes = LEAN_MAX_BYTES,
	): Promise<LeanCommandResult> {
		const view = await shown(workspace, page.id, page, from, maxBytes);
		const positions = await commandCursors();
		if (view.end === undefined) positions.delete(page.id);
		else positions.set(page.id, view.end);
		return {
			id: page.id,
			status: page.status,
			...(page.stopped ? { stopped: page.stopped } : {}),
			command,
			output: view.output,
			outputPath: outputPath(page.id),
			...(view.note ? { truncationNote: view.note } : {}),
			wallSeconds: Math.round((Date.now() - started) / 100) / 10,
			...(page.note ? { note: page.note } : {}),
		};
	}

	/** Adds the captures note to a finished command's result; a failure only costs the note. */
	async function withCaptures(
		workspace: AgentToolWorkspace,
		result: LeanCommandResult,
		options: ExecuteOptions,
	): Promise<LeanCommandResult> {
		if (!context.collectCaptures || result.status === "running") return result;
		const note = await context
			.collectCaptures(workspace, options.toolCallId)
			.catch((error: unknown) => {
				console.warn("Agent captures were not collected.", error);
				return "";
			});
		return note
			? { ...result, note: result.note ? `${result.note}\n${note}` : note }
			: result;
	}

	return {
		ready,
		outputPath,
		/**
		 * Runs a command. It returns when the command exits, or once `yieldSeconds`
		 * pass while it still runs; `waitSeconds` then keeps waiting for the exit
		 * (bounded by the step's deadline). A command still running returns its id.
		 */
		async run(
			input: {
				command: string;
				workdir?: string;
				maxSeconds: number;
				yieldSeconds: number;
				waitSeconds?: number;
				maxBytes?: number;
				/**
				 * Start it in the background: it returns at once with the command's id,
				 * runs until it exits or is stopped (bounded only by the long background
				 * cap, backgroundCommandMaxSeconds), and survives the turn; its agent is
				 * told when it exits. `maxSeconds`, `yieldSeconds` and `waitSeconds` are ignored.
				 */
				background?: boolean;
			},
			options: ExecuteOptions,
		): Promise<LeanCommandResult> {
			const workspace = await ready();
			const started = Date.now();
			const command = input.workdir
				? `cd ${quote(input.workdir)} && ${input.command}`
				: input.command;
			if (input.background) {
				const page = await call(
					"execute_command",
					{
						command,
						maxSeconds: LEAN_COMMAND_MAX_SECONDS,
						yieldSeconds: 0,
						background: { label: backgroundCommandLabel(input.command) },
					},
					options,
				);
				return {
					...(await settle(
						workspace,
						input.command,
						page,
						0,
						started,
						input.maxBytes,
					)),
					background: true,
				};
			}
			let page = await call(
				"execute_command",
				{
					command,
					maxSeconds: Math.min(
						LEAN_COMMAND_MAX_SECONDS,
						Math.max(30, Math.ceil(input.maxSeconds)),
					),
					yieldSeconds: Math.min(
						LEAN_YIELD_MAX_SECONDS,
						Math.max(0, Math.round(input.yieldSeconds)),
					),
				},
				options,
			);
			if (page.status === "running" && input.waitSeconds)
				page = {
					...(await call(
						"continue_command",
						{
							id: page.id,
							start: 0,
							seconds: Math.min(
								COMMAND_WAIT_MAX_SECONDS,
								Math.ceil(input.waitSeconds),
							),
						},
						options,
					)),
					id: page.id,
				};
			const result = await settle(
				workspace,
				input.command,
				page,
				0,
				started,
				input.maxBytes,
			);
			return CAPTURING_COMMAND.test(input.command)
				? withCaptures(workspace, result, options)
				: result;
		},
		/** Writes to a running command and/or waits; returns output since the last read. Ctrl-C stops it. */
		async write(
			input: {
				id: string;
				chars: string;
				yieldSeconds?: number;
				maxBytes?: number;
			},
			options: ExecuteOptions,
		): Promise<LeanCommandResult> {
			const workspace = await ready();
			const started = Date.now();
			const positions = await commandCursors();
			if (input.chars.includes("\u0003")) {
				await call("stop_command", { id: input.id }, options);
				return settle(
					workspace,
					"",
					{
						id: input.id,
						status: STOPPED_COMMAND_STATUS,
						start: -1,
						stdout: "",
					},
					positions.get(input.id) ?? 0,
					started,
					input.maxBytes,
				);
			}
			const eof = input.chars.includes("\u0004");
			const chars = input.chars.replaceAll("\u0004", "");
			const from = positions.get(input.id) ?? 0;
			const page = await call(
				"continue_command",
				{
					id: input.id,
					...(chars ? { chars } : {}),
					...(eof ? { eof } : {}),
					start: from,
					...(input.yieldSeconds !== undefined
						? {
								seconds: Math.min(
									COMMAND_WAIT_MAX_SECONDS,
									Math.max(0, Math.ceil(input.yieldSeconds)),
								),
							}
						: {}),
				},
				options,
			);
			return withCaptures(
				workspace,
				await settle(
					workspace,
					"",
					{ ...page, id: input.id },
					from,
					started,
					input.maxBytes,
				),
				options,
			);
		},
		async readFile(
			path: string,
			range: { offset: number; limit: number; maxLineCharacters?: number },
		): Promise<FileRead> {
			const workspace = await ready();
			const result = await workspace.machines.exec(
				workspace.vm,
				`python3 -c ${quote(READ_SCRIPT)} ${quote(path)} ${quote(workspace.cwd)} page ${Math.max(1, range.offset)} ${Math.max(1, range.limit)} ${LEAN_MAX_BYTES} ${range.maxLineCharacters ?? 0}`,
				HELPER_EXEC_MS,
			);
			if (result.exitCode || result.stdout.length > 8_000_000)
				throw new Error(`Could not read ${path}.`);
			return JSON.parse(result.stdout) as FileRead;
		},
		/** The whole UTF-8 file and its hash, or null when it does not exist. */
		async readWhole(path: string) {
			const workspace = await ready();
			const result = await workspace.machines.exec(
				workspace.vm,
				`python3 -c ${quote(READ_SCRIPT)} ${quote(path)} ${quote(workspace.cwd)} full 1 1 0 0`,
				HELPER_EXEC_MS,
			);
			if (result.exitCode) throw new Error(`Could not read ${path}.`);
			const read = JSON.parse(result.stdout) as {
				path: string;
				missing?: true;
				directory?: true;
				error?: string;
				content?: string;
				sha256?: string;
			};
			if (read.directory) throw new LeanEditError(`${path} is a directory.`);
			if (read.error) throw new LeanEditError(`${path}: ${read.error}.`);
			return read.missing
				? { path: read.path, content: null, sha256: null }
				: {
						path: read.path,
						content: read.content as string,
						sha256: read.sha256 as string,
					};
		},
		/** Writes a whole file; with `expectedSha256` (null: must not exist) it refuses a file that changed. */
		async writeFile(
			path: string,
			content: string,
			expectedSha256?: string | null,
		) {
			const workspace = await ready();
			const payload = `/tmp/ytimesy-lean-write-${randomUUID()}.json`;
			await workspace.machines.writeTextFile(
				workspace.vm,
				payload,
				JSON.stringify({
					path,
					cwd: workspace.cwd,
					roots: writableRoots(workspace.cwd),
					content,
					...(expectedSha256 !== undefined ? { expectedSha256 } : {}),
				}),
			);
			const result = await workspace.machines.exec(
				workspace.vm,
				`python3 -c ${quote(WRITE_SCRIPT)} ${quote(payload)}`,
				HELPER_EXEC_MS,
			);
			if (result.exitCode)
				throw new Error(
					`Could not write ${path}: ${result.stderr.slice(-400)}`.trim(),
				);
			const written = JSON.parse(result.stdout) as {
				path: string;
				error?: string;
				created?: boolean;
				bytes?: number;
				lines?: number;
			};
			if (written.error === "outside")
				throw new LeanEditError(
					`${written.path} is outside the repository (${workspace.cwd}) and ${MEMORY_DIRECTORY}; file tools write only there. Use a shell command for scratch files elsewhere.`,
				);
			if (written.error === "stale")
				throw new LeanEditError(
					`${path} changed while it was being edited; read it again and retry.`,
				);
			if (written.error)
				throw new LeanEditError(`Could not write ${path}: ${written.error}.`);
			return written as {
				path: string;
				created: boolean;
				bytes: number;
				lines: number;
			};
		},
		/** Reads, applies `change` to the current text, and writes back unless the file changed meanwhile. */
		async editFile(
			path: string,
			change: (content: string | null) => {
				content: string;
				replacements: number;
				fuzzy: boolean;
			},
		) {
			const current = await this.readWhole(path);
			const edited = change(current.content);
			const written = await this.writeFile(
				path,
				edited.content,
				current.sha256,
			);
			return { ...edited, path: written.path, created: written.created };
		},
		/** A quick read-only search command (rg); output limited with the head kept. */
		async search(command: string, emptyMessage: string) {
			const workspace = await ready();
			const result = await workspace.machines.exec(
				workspace.vm,
				`cd ${quote(workspace.cwd)} && ${command}`,
				60_000,
			);
			if (result.exitCode > 1)
				throw new Error(
					result.stderr.trim().slice(-600) ||
						`Search failed (exit ${result.exitCode}).`,
				);
			if (!result.stdout.trim()) return emptyMessage;
			const truncation = keepHead(result.stdout);
			return truncation.truncated
				? `${truncation.content}[Showing the first ${truncation.lastLine} of ${truncation.totalLines} lines; narrow the search to see the rest.]`
				: truncation.content;
		},
		once,
		cwd: async () => (await ready()).cwd,
	};
}

export type LeanEngine = ReturnType<typeof leanEngine>;
