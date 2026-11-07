import { randomUUID } from "node:crypto";
import type { ModelMessage, ToolSet } from "ai";
import { z } from "zod";
import type { ApiAgentEvent } from "../../domain/api-agent-event";
import type { AgentToolWorkspace } from "./agent-tool-workspace";
import { inspectProjectSourceEvidence } from "./project-source-evidence";
import {
	readRepositoryInstructions,
	withRepositoryInstructions,
} from "./repository-instructions";

const source = z.object({
	path: z.string(),
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const fileTools = new Set([
	"batch_read",
	"read_file",
	"read_files",
	"read_code",
	"inspect_code",
	"inspect_code_batch",
	"create_file",
	"replace_text",
	"apply_patch",
	"apply_patches",
	"rename_symbol",
	"rename_file",
	"apply_code_action",
]);
const reads = new Set(["read_file", "read_files", "read_code"]);
const writes = new Set([
	"create_file",
	"replace_text",
	"apply_patch",
	"apply_patches",
	"rename_symbol",
	"rename_file",
	"apply_code_action",
]);

function pathsFrom(value: unknown): string[] {
	// Freeform apply_patch input is raw patch text that names its files in headers.
	if (typeof value === "string")
		return [
			...value.matchAll(
				/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm,
			),
		]
			.map((match) => match[1].trim())
			.filter(
				(path) =>
					!path.startsWith("/") &&
					!path.split("/").some((part) => part === ".." || part === ".git"),
			);
	if (!value || typeof value !== "object") return [];
	if (Array.isArray(value)) return value.flatMap(pathsFrom);
	const record = value as Record<string, unknown>;
	return [
		typeof record.path === "string" ? record.path : null,
		typeof record.newPath === "string" ? record.newPath : null,
		...(Array.isArray(record.paths)
			? record.paths.filter((path): path is string => typeof path === "string")
			: []),
		...[
			"operation",
			"operations",
			"files",
			"queries",
			"completed",
			"reads",
			"arguments",
		].flatMap((key) => pathsFrom(record[key])),
	].filter(
		(path): path is string =>
			!!path &&
			!path.startsWith("/") &&
			!path.split("/").some((part) => part === ".." || part === ".git"),
	);
}

/** Append fresh evidence at safe points; never rewrite provider-bound history or treat hashes as semantic proof. */
export function automaticRepositoryContext(input: {
	tools: ToolSet;
	workspace: () => Promise<AgentToolWorkspace>;
	signal: AbortSignal;
	onEvent: (event: ApiAgentEvent) => Promise<void>;
	/**
	 * The runtime supplies repository instructions as conversation messages (no
	 * guidance tool): at turn start when absent or changed, and after compaction.
	 * Without it, guidance arrives as read_repository_guidance receipts.
	 */
	instructionMessages?: {
		/**
		 * Read when the first step is prepared: a request sent before its
		 * workspace is ready leaves the check to a later step.
		 */
		turnStart: boolean | (() => boolean);
	};
}) {
	let instructionsChecked: boolean | undefined;
	const turnStartCheckDue = () => {
		const turnStart = input.instructionMessages?.turnStart;
		instructionsChecked ??= !(typeof turnStart === "function"
			? turnStart()
			: turnStart);
		return !instructionsChecked;
	};
	let history: ModelMessage[] = [];
	let pending: ModelMessage[] = [];
	let guidanceWork = Promise.resolve();
	let instructionsAwaitingDelivery = false;
	const loadedScopes = new Set<string>();
	const watched = new Map<string, string>();
	const invalidated = new Set<string>();

	function observe(name: string, output: unknown) {
		if (name === "compose_tools") {
			for (const entry of (
				output as {
					steps?: { tool: string; status: string; result: unknown }[];
				}
			)?.steps ?? [])
				if (entry.status === "completed") observe(entry.tool, entry.result);
			return;
		}
		if (name === "batch_read") {
			for (const entry of (
				output as {
					reads?: { tool: string; status: string; result: unknown }[];
				}
			)?.reads ?? [])
				if (entry.status === "completed") observe(entry.tool, entry.result);
			return;
		}
		if (!reads.has(name) && name !== "read_repository_guidance") return;
		if (name === "read_repository_guidance") {
			// Durable steps reconstruct this wrapper. Surviving receipts establish
			// which scopes were already supplied; process memory does not.
			const receipt = z
				.object({
					scope: z.string().optional(),
					instructions: z.array(z.unknown()),
				})
				.safeParse(output);
			if (receipt.success) {
				const scope = receipt.data.scope ?? ".";
				if (
					scope === "." ||
					(scope.length > 0 &&
						!scope.startsWith("/") &&
						!scope.includes("\\") &&
						scope
							.split("/")
							.every((segment) => segment !== ".." && segment !== ".git"))
				)
					loadedScopes.add(scope);
			}
		}
		const entries =
			name === "read_repository_guidance"
				? ((output as { instructions?: unknown[] })?.instructions ?? [])
				: name === "read_code"
					? ((output as { files?: unknown[] })?.files ?? [])
					: Array.isArray(output)
						? output
						: [output];
		for (const entry of entries) {
			const parsed = source.safeParse(entry);
			if (!parsed.success || !pathsFrom(parsed.data).length) continue;
			watched.delete(parsed.data.path);
			watched.set(parsed.data.path, parsed.data.sha256);
			invalidated.delete(parsed.data.path);
			if (watched.size > 32)
				watched.delete(watched.keys().next().value as string);
		}
	}

	async function load(scope: string, force = false) {
		const execute = input.tools.read_repository_guidance?.execute;
		if (
			input.instructionMessages ||
			!execute ||
			(!force && loadedScopes.has(scope))
		)
			return;
		const id = `call_context_${randomUUID().replaceAll("-", "")}`;
		const args = { scope };
		const messages = [...history, ...pending];
		await input.onEvent({
			type: "tool-call",
			id,
			name: "read_repository_guidance",
			input: args,
		});
		const output = z.json().parse(
			await execute(args, {
				toolCallId: id,
				messages,
				abortSignal: input.signal,
				context: {},
			}),
		);
		const packet = output as { instructions?: { content?: string }[] };
		if (packet.instructions?.some((entry) => typeof entry.content === "string"))
			instructionsAwaitingDelivery = true;
		pending.push(
			{
				role: "assistant",
				content: [
					{
						type: "tool-call",
						toolCallId: id,
						toolName: "read_repository_guidance",
						input: args,
					},
				],
			},
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: id,
						toolName: "read_repository_guidance",
						output: { type: "json", value: output },
					},
				],
			},
		);
		loadedScopes.add(scope);
		await input.onEvent({
			type: "tool-result",
			id,
			name: "read_repository_guidance",
			output,
		});
	}

	function drain(messages: ModelMessage[]) {
		history = pending.length ? [...messages, ...pending] : messages;
		pending = [];
		instructionsAwaitingDelivery = false;
		return history;
	}

	const tools = Object.fromEntries(
		Object.entries(input.tools).map(([name, definition]) => {
			const execute = definition.execute;
			if (!execute || !fileTools.has(name)) return [name, definition];
			return [
				name,
				{
					...definition,
					execute: async (
						args: unknown,
						options: Parameters<NonNullable<typeof execute>>[1],
					) => {
						const scopes = [
							...new Set(
								pathsFrom(args).map((path) =>
									path.includes("/")
										? path.slice(0, path.lastIndexOf("/"))
										: ".",
								),
							),
						];
						const job = guidanceWork.then(async () => {
							input.signal.throwIfAborted();
							for (const scope of scopes.slice(0, 8)) await load(scope);
						});
						guidanceWork = job.catch(() => undefined);
						await job;
						if (writes.has(name) && instructionsAwaitingDelivery) {
							const message =
								"New scoped repository instructions were added to context. Review them before retrying this edit; no files were changed.";
							if (name === "apply_patch" && definition.type === "provider")
								return { status: "failed", output: message };
							return {
								status: "instructions_loaded",
								retryRequired: true,
								message,
							};
						}
						const output = await execute(args as never, options);
						observe(name, output);
						return output;
					},
				},
			];
		}),
	) as ToolSet;

	return {
		tools,
		afterTools: async (messages: ModelMessage[]) => {
			await guidanceWork;
			return drain(messages);
		},
		restoreInstructions: async (messages: ModelMessage[]) => {
			history = messages;
			loadedScopes.clear();
			const ledger = watched.size
				? [
						{
							role: "user" as const,
							content: `Runtime source read ledger: ${JSON.stringify([...watched].map(([path, sha256]) => ({ path, sha256 })))}`,
						},
					]
				: [];
			await load(".", true);
			if (input.instructionMessages) {
				input.signal.throwIfAborted();
				messages = withRepositoryInstructions(
					messages,
					await readRepositoryInstructions(await input.workspace()),
					"compaction",
				);
			}
			return drain([...messages, ...ledger]);
		},
		prepare: async (messages: ModelMessage[]) => {
			history = messages;
			watched.clear();
			invalidated.clear();
			// Durable step mode reconstructs read evidence from the saved transcript.
			for (const message of messages) {
				if (
					(message.role === "assistant" || message.role === "user") &&
					typeof message.content === "string" &&
					message.content.startsWith("Runtime source read ledger: ")
				) {
					try {
						for (const record of JSON.parse(
							message.content.slice("Runtime source read ledger: ".length),
						))
							observe("read_file", record);
					} catch {
						/* An incomplete ledger carries no evidence. */
					}
				}

				if (
					(message.role === "assistant" || message.role === "user") &&
					typeof message.content === "string" &&
					message.content.startsWith(
						"Runtime source freshness notice (not a user instruction): ",
					)
				) {
					const raw = message.content
						.slice(
							"Runtime source freshness notice (not a user instruction): "
								.length,
						)
						.split(". Earlier contents")[0];
					try {
						for (const item of JSON.parse(raw))
							if (watched.get(item.path) === item.previousSha256)
								invalidated.add(item.path);
					} catch {
						/* An incomplete notice establishes no freshness. */
					}
				}
				if (message.role === "tool")
					for (const part of message.content) {
						if (
							part.type === "tool-result" &&
							part.toolName === "source_freshness_notice" &&
							part.output.type === "json"
						) {
							const notice = part.output.value as {
								changed?: { path?: unknown; previousSha256?: unknown }[];
							} | null;
							for (const item of notice?.changed ?? [])
								if (
									typeof item.path === "string" &&
									watched.get(item.path) === item.previousSha256
								)
									invalidated.add(item.path);
							continue;
						}
						if (part.type === "tool-result" && part.output.type === "json") {
							observe(part.toolName, part.output.value);
						}
					}
			}
			if (!loadedScopes.size && input.tools.read_repository_guidance?.execute)
				await load(".");
			if (watched.size) {
				const workspace = await input.workspace();
				const changed: {
					path: string;
					previousSha256: string;
					currentSha256: string | null;
				}[] = [];
				const entries = [...watched];
				for (let start = 0; start < entries.length; start += 8) {
					input.signal.throwIfAborted();
					const current = await inspectProjectSourceEvidence(
						workspace,
						entries.slice(start, start + 8).map(([path]) => path),
						true,
					);
					for (const record of current.sources) {
						const previous = watched.get(record.path);
						if (
							previous &&
							previous !== record.sha256 &&
							!invalidated.has(record.path)
						) {
							changed.push({
								path: record.path,
								previousSha256: previous,
								currentSha256: record.sha256,
							});
							invalidated.add(record.path);
						}
					}
				}
				for (const entry of changed)
					if (/(?:^|\/)(AGENTS|CLAUDE)\.md$/.test(entry.path)) {
						loadedScopes.clear();
						await load(
							entry.path.includes("/")
								? entry.path.slice(0, entry.path.lastIndexOf("/"))
								: ".",
							true,
						);
					}
				if (changed.length) {
					// A trailing user turn defeats provider prompt-cache reuse (measured in
					// pilots); a runtime tool result keeps the input ending in tool output.
					const id = `call_freshness_${randomUUID().replaceAll("-", "")}`;
					const output = {
						notice:
							"Runtime source freshness notice (not a user instruction). Earlier contents are stale or unavailable. Read current source before reasoning from these files; a hash change says nothing about correctness.",
						changed,
					};
					pending.push(
						{
							role: "assistant",
							content: [
								{
									type: "tool-call",
									toolCallId: id,
									toolName: "source_freshness_notice",
									input: {},
								},
							],
						},
						{
							role: "tool",
							content: [
								{
									type: "tool-result",
									toolCallId: id,
									toolName: "source_freshness_notice",
									output: { type: "json", value: output },
								},
							],
						},
					);
				}
			}
			if (turnStartCheckDue()) {
				input.signal.throwIfAborted();
				messages = withRepositoryInstructions(
					messages,
					await readRepositoryInstructions(await input.workspace()),
					"turn-start",
				);
				instructionsChecked = true;
			}
			return drain(messages);
		},
	};
}
