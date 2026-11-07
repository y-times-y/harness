// Synthetic, hand-written session fixtures for tests. Shapes follow what each CLI
// writes; no content comes from real sessions.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface FixtureWorld {
	home: string;
	repo: string;
	cleanup(): void;
}

export function createFixtureWorld(): FixtureWorld {
	const base = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "local-sessions-")),
	);
	const home = path.join(base, "home");
	const repo = path.join(base, "work", "repo");
	fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
	fs.mkdirSync(path.join(repo, "packages", "app"), { recursive: true });
	fs.mkdirSync(home, { recursive: true });
	return {
		home,
		repo,
		cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
	};
}

export function writeJsonl(file: string, records: unknown[]): string {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(
		file,
		`${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
	);
	return file;
}

export function setMtime(file: string, epochMs: number): void {
	const time = new Date(epochMs);
	fs.utimesSync(file, time, time);
}

export function claudeFile(home: string, cwd: string, id: string): string {
	return path.join(
		home,
		".claude",
		"projects",
		cwd.replace(/[^A-Za-z0-9]/g, "-"),
		`${id}.jsonl`,
	);
}

/** Claude Code 2.1.x shape: one content block per assistant line, bookkeeping records around it. */
export function claude21Records(cwd: string) {
	const envelope = (extra: object) => ({
		cwd,
		sessionId: "c21",
		version: "2.1.296",
		gitBranch: "feature-x",
		isSidechain: false,
		userType: "external",
		entrypoint: "cli",
		...extra,
	});
	return [
		{
			type: "queue-operation",
			operation: "enqueue",
			content: "fix the parser",
		},
		envelope({
			type: "attachment",
			attachment: { type: "hook_success", content: "noise" },
			timestamp: "2026-01-01T00:00:00.000Z",
		}),
		envelope({
			type: "user",
			message: { role: "user", content: "fix the parser please" },
			origin: { kind: "human" },
			promptSource: "typed",
			timestamp: "2026-01-01T00:00:01.000Z",
		}),
		envelope({
			type: "user",
			isMeta: true,
			message: {
				role: "user",
				content: "<system-reminder>injected</system-reminder>",
			},
			timestamp: "2026-01-01T00:00:01.500Z",
		}),
		envelope({
			type: "assistant",
			message: {
				id: "msg_1",
				model: "claude-test-1",
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "private reasoning", signature: "sig" },
				],
			},
			timestamp: "2026-01-01T00:00:02.000Z",
		}),
		envelope({
			type: "assistant",
			message: {
				id: "msg_1",
				model: "claude-test-1",
				role: "assistant",
				content: [{ type: "text", text: "Running the tests first." }],
			},
			timestamp: "2026-01-01T00:00:02.100Z",
		}),
		envelope({
			type: "assistant",
			message: {
				id: "msg_1",
				model: "claude-test-1",
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "toolu_1",
						name: "Bash",
						input: { command: "npm install" },
					},
				],
			},
			timestamp: "2026-01-01T00:00:03.000Z",
		}),
		envelope({
			type: "user",
			message: {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "toolu_1",
						content: "added 3 packages",
						is_error: false,
					},
				],
			},
			toolUseResult: {
				stdout: "added 3 packages",
				stderr: "",
				interrupted: false,
				isImage: false,
			},
			timestamp: "2026-01-01T00:00:04.000Z",
		}),
		envelope({
			type: "assistant",
			message: {
				id: "msg_2",
				model: "claude-test-1",
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "toolu_2",
						name: "Bash",
						input: { command: "npm test" },
					},
				],
			},
			timestamp: "2026-01-01T00:00:05.000Z",
		}),
		envelope({
			type: "user",
			message: {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "toolu_2",
						content: "Exit code 1\n1 failing",
						is_error: true,
					},
				],
			},
			toolUseResult: "Error: Exit code 1\n1 failing",
			timestamp: "2026-01-01T00:00:06.000Z",
		}),
		envelope({
			type: "assistant",
			message: {
				id: "msg_3",
				model: "claude-test-1",
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "toolu_3",
						name: "Read",
						input: { file_path: `${cwd}/src/parser.ts` },
					},
				],
			},
			timestamp: "2026-01-01T00:00:07.000Z",
		}),
		envelope({
			type: "user",
			message: {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "toolu_3",
						content: "export const parse = 1;",
					},
				],
			},
			timestamp: "2026-01-01T00:00:08.000Z",
		}),
		envelope({
			type: "assistant",
			message: {
				id: "msg_4",
				model: "claude-test-1",
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "toolu_4",
						name: "Edit",
						input: {
							file_path: `${cwd}/src/parser.ts`,
							old_string: "1",
							new_string: "2",
						},
					},
				],
			},
			timestamp: "2026-01-01T00:00:09.000Z",
		}),
		envelope({
			type: "user",
			message: {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "toolu_4",
						content: "ok",
						is_error: false,
					},
				],
			},
			toolUseResult: { filePath: `${cwd}/src/parser.ts`, structuredPatch: [] },
			timestamp: "2026-01-01T00:00:10.000Z",
		}),
		envelope({
			type: "assistant",
			message: {
				id: "msg_5",
				model: "claude-test-1",
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "toolu_5",
						name: "Bash",
						input: { command: "sed -i '' s/a/b/ src/lexer.ts" },
					},
				],
			},
			timestamp: "2026-01-01T00:00:11.000Z",
		}),
		envelope({
			type: "user",
			message: {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "toolu_5",
						content: "",
						is_error: false,
					},
				],
			},
			toolUseResult: {
				stdout: "",
				stderr: "",
				interrupted: false,
				bashEditDiff: { changedFiles: [`${cwd}/src/lexer.ts`] },
			},
			timestamp: "2026-01-01T00:00:12.000Z",
		}),
		envelope({
			type: "assistant",
			message: {
				id: "msg_6",
				model: "claude-test-1",
				role: "assistant",
				content: [{ type: "text", text: "Fixed." }],
			},
			timestamp: "2026-01-01T00:00:13.000Z",
		}),
		{ type: "ai-title", aiTitle: "Parser fix", sessionId: "c21" },
		{ type: "system", subtype: "turn_duration", durationMs: 10 },
		{ type: "file-history-snapshot", snapshot: {} },
		{ type: "last-prompt", lastPrompt: "fix the parser please" },
	];
}

export function claudeCompactedRecords(cwd: string) {
	const base = { cwd, sessionId: "cc", version: "2.1.200", isSidechain: false };
	return [
		{
			...base,
			type: "user",
			message: { role: "user", content: "old request" },
			timestamp: "2026-01-02T00:00:00.000Z",
		},
		{
			...base,
			type: "assistant",
			message: {
				id: "m1",
				role: "assistant",
				model: "claude-test-1",
				content: [{ type: "text", text: "old answer" }],
			},
			timestamp: "2026-01-02T00:00:01.000Z",
		},
		{
			...base,
			type: "system",
			subtype: "compact_boundary",
			compactMetadata: { trigger: "auto" },
		},
		{
			...base,
			type: "user",
			isCompactSummary: true,
			message: {
				role: "user",
				content:
					"This session is being continued from a previous conversation that ran out of context. Summary: parser work.",
			},
			timestamp: "2026-01-02T00:00:02.000Z",
		},
		{
			...base,
			type: "user",
			message: { role: "user", content: "continue with the lexer" },
			timestamp: "2026-01-02T00:00:03.000Z",
		},
		{
			...base,
			type: "assistant",
			message: {
				id: "m2",
				role: "assistant",
				model: "claude-test-1",
				content: [{ type: "text", text: "On it." }],
			},
			timestamp: "2026-01-02T00:00:04.000Z",
		},
	];
}

/** Claude Code 1.x / 2.0 shape (agent-hop era): summary title line, inline sidechain records. */
export function claudeLegacyRecords(cwd: string) {
	const base = { cwd, sessionId: "old", version: "1.0.80" };
	return [
		{ type: "summary", summary: "Legacy session title", leafUuid: "u3" },
		{
			...base,
			type: "user",
			isSidechain: false,
			message: {
				role: "user",
				content: [{ type: "text", text: "list files" }],
			},
		},
		{
			...base,
			type: "assistant",
			isSidechain: false,
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "Listing." },
					{ type: "tool_use", id: "t1", name: "LS", input: { path: cwd } },
				],
			},
		},
		{
			...base,
			type: "user",
			isSidechain: true,
			message: { role: "user", content: "subagent prompt" },
		},
		{
			...base,
			type: "user",
			isSidechain: false,
			message: {
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "t1", content: "a.txt" }],
			},
		},
		"this line is not json",
	];
}

export function codexItemModeRecords(cwd: string) {
	const ts = (n: number) =>
		`2026-02-01T00:00:${String(n).padStart(2, "0")}.000Z`;
	return [
		{
			timestamp: ts(0),
			type: "session_meta",
			payload: {
				id: "01a0-item",
				cwd,
				cli_version: "0.161.0",
				originator: "codex_exec",
				git: { branch: "main", commit_hash: "abc" },
				base_instructions: { text: "You are Codex." },
				timestamp: ts(0),
			},
		},
		{
			timestamp: ts(1),
			type: "turn_context",
			payload: { cwd, model: "gpt-test" },
		},
		{
			timestamp: ts(2),
			type: "response_item",
			payload: {
				type: "message",
				role: "user",
				content: [
					{
						type: "input_text",
						text: "# AGENTS.md instructions\n\n<INSTRUCTIONS>x</INSTRUCTIONS>",
					},
				],
			},
		},
		{
			timestamp: ts(3),
			type: "response_item",
			payload: {
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "install and test" }],
			},
		},
		{
			timestamp: ts(4),
			type: "event_msg",
			payload: {
				type: "item_completed",
				item: {
					type: "UserMessage",
					content: [{ type: "text", text: "install and test" }],
				},
			},
		},
		{
			timestamp: ts(5),
			type: "event_msg",
			payload: { type: "token_count", info: {} },
		},
		{
			timestamp: ts(5),
			type: "response_item",
			payload: { type: "reasoning", summary: [], encrypted_content: "zz" },
		},
		{
			timestamp: ts(6),
			type: "response_item",
			payload: {
				type: "custom_tool_call",
				name: "exec",
				call_id: "call_1",
				input: 'text(await tools.exec_command({cmd:"pnpm install"}));',
			},
		},
		{
			timestamp: ts(7),
			type: "event_msg",
			payload: {
				type: "item_completed",
				item: {
					type: "CommandExecution",
					command: ["/bin/zsh", "-lc", "pnpm install"],
					cwd: `file://${cwd}`,
					parsed_cmd: [{ type: "unknown", cmd: "pnpm install" }],
					status: "completed",
					aggregated_output: "done\n",
					exit_code: 0,
				},
			},
		},
		{
			timestamp: ts(8),
			type: "event_msg",
			payload: {
				type: "item_completed",
				item: {
					type: "CommandExecution",
					command: ["/bin/zsh", "-lc", "cat README.md"],
					cwd: `file://${cwd}`,
					parsed_cmd: [
						{
							type: "read",
							cmd: "cat README.md",
							name: "README.md",
							path: "README.md",
						},
					],
					status: "completed",
					aggregated_output: "# readme\n",
					exit_code: 0,
				},
			},
		},
		{
			timestamp: ts(9),
			type: "event_msg",
			payload: {
				type: "item_completed",
				item: {
					type: "CommandExecution",
					command: ["/bin/zsh", "-lc", "pnpm test"],
					cwd: `file://${cwd}`,
					status: "failed",
					aggregated_output: "1 failed\n",
					exit_code: 1,
				},
			},
		},
		{
			timestamp: ts(10),
			type: "response_item",
			payload: {
				type: "custom_tool_call_output",
				call_id: "call_1",
				output: [{ type: "input_text", text: "Script completed" }],
			},
		},
		{
			timestamp: ts(11),
			type: "event_msg",
			payload: {
				type: "item_completed",
				item: {
					type: "FileChange",
					changes: {
						[`${cwd}/src/a.ts`]: {
							type: "update",
							unified_diff: "@@ -1 +1 @@\n-a\n+b\n",
						},
					},
					status: "completed",
					stdout: "Success.",
					stderr: "",
				},
			},
		},
		{
			timestamp: ts(12),
			type: "response_item",
			payload: {
				type: "message",
				role: "assistant",
				phase: "final_answer",
				content: [{ type: "output_text", text: "Installed; one test fails." }],
			},
		},
		{
			timestamp: ts(13),
			type: "compacted",
			payload: {
				message: "",
				replacement_history: [{ type: "compaction", encrypted_content: "x" }],
			},
		},
	];
}

/** Wrapped rollout from before item events (agent-hop era): function calls + exec_command_end. */
export function codexLegacyRecords(cwd: string) {
	return [
		{
			timestamp: "2025-09-01T00:00:00.000Z",
			type: "session_meta",
			payload: {
				id: "legacy-1",
				cwd,
				cli_version: "0.42.0",
				git: { branch: "dev" },
			},
		},
		{
			timestamp: "2025-09-01T00:00:01.000Z",
			type: "response_item",
			payload: {
				type: "message",
				role: "user",
				content: [
					{
						type: "input_text",
						text: `<environment_context>\n  <cwd>${cwd}</cwd>\n</environment_context>`,
					},
				],
			},
		},
		{
			timestamp: "2025-09-01T00:00:02.000Z",
			type: "response_item",
			payload: {
				type: "message",
				role: "user",
				content: [
					{
						type: "input_text",
						text: "# Context from my IDE setup:\n\n## Open tabs:\n- a.ts\n\n## My request for Codex:\nbuild it",
					},
				],
			},
		},
		{
			timestamp: "2025-09-01T00:00:03.000Z",
			type: "response_item",
			payload: {
				type: "function_call",
				name: "shell",
				call_id: "c1",
				arguments: JSON.stringify({
					command: ["bash", "-lc", "make build"],
					workdir: cwd,
				}),
			},
		},
		{
			timestamp: "2025-09-01T00:00:04.000Z",
			type: "response_item",
			payload: {
				type: "function_call_output",
				call_id: "c1",
				output: JSON.stringify({
					output: "built",
					metadata: { exit_code: 0, duration_seconds: 1 },
				}),
			},
		},
		{
			timestamp: "2025-09-01T00:00:05.000Z",
			type: "response_item",
			payload: {
				type: "function_call",
				name: "shell_command",
				call_id: "c2",
				arguments: JSON.stringify({ command: "make lint" }),
			},
		},
		{
			timestamp: "2025-09-01T00:00:06.000Z",
			type: "response_item",
			payload: {
				type: "function_call_output",
				call_id: "c2",
				output: "Exit code: 2\nWall time: 1 seconds\nOutput:\nlint failed",
			},
		},
		{
			timestamp: "2025-09-01T00:00:07.000Z",
			type: "response_item",
			payload: {
				type: "custom_tool_call",
				name: "apply_patch",
				call_id: "c3",
				input:
					"*** Begin Patch\n*** Update File: src/main.c\n@@\n-a\n+b\n*** Add File: src/new.c\n+x\n*** End Patch",
			},
		},
		{
			timestamp: "2025-09-01T00:00:08.000Z",
			type: "event_msg",
			payload: {
				type: "patch_apply_end",
				call_id: "c3",
				success: true,
				changes: {},
			},
		},
		{
			timestamp: "2025-09-01T00:00:09.000Z",
			type: "response_item",
			payload: {
				type: "custom_tool_call_output",
				call_id: "c3",
				output: JSON.stringify({
					output:
						"Success. Updated the following files:\nM src/main.c\nA src/new.c\n",
					metadata: { exit_code: 0 },
				}),
			},
		},
		{
			timestamp: "2025-09-01T00:00:10.000Z",
			type: "response_item",
			payload: {
				type: "function_call",
				name: "exec_command",
				call_id: "c4",
				arguments: JSON.stringify({ cmd: "make test" }),
			},
		},
		{
			timestamp: "2025-09-01T00:00:11.000Z",
			type: "event_msg",
			payload: {
				type: "exec_command_end",
				call_id: "c4",
				exit_code: 0,
				aggregated_output: "ok",
			},
		},
		{
			timestamp: "2025-09-01T00:00:12.000Z",
			type: "response_item",
			payload: {
				type: "function_call_output",
				call_id: "c4",
				output:
					"Chunk ID: 1\nWall time: 0.1\nProcess exited with code 0\nOutput:\nok",
			},
		},
		{
			timestamp: "2025-09-01T00:00:13.000Z",
			type: "compacted",
			payload: { message: "Summary of the build work so far." },
		},
		{
			timestamp: "2025-09-01T00:00:14.000Z",
			type: "response_item",
			payload: {
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "Build done." }],
			},
		},
	];
}

/** Pre-wrapper rollout (early 2025): header line without cwd, bare response items. */
export function codexBareRecords(cwd: string) {
	return [
		{ id: "bare-1", timestamp: "2025-04-01T00:00:00.000Z", instructions: "" },
		{
			type: "message",
			role: "user",
			content: [
				{
					type: "input_text",
					text: `<environment_context>\n<cwd>${cwd}</cwd>\n</environment_context>`,
				},
			],
		},
		{ record_type: "state" },
		{
			type: "message",
			role: "user",
			content: [{ type: "input_text", text: "say hi" }],
		},
		{
			type: "function_call",
			name: "shell",
			call_id: "b1",
			arguments: JSON.stringify({ command: ["echo", "hi"] }),
		},
		{
			type: "function_call_output",
			call_id: "b1",
			output: JSON.stringify({ output: "hi", metadata: { exit_code: 0 } }),
		},
		{
			type: "message",
			role: "assistant",
			content: [{ type: "output_text", text: "hi" }],
		},
	];
}

export function piRecords(cwd: string) {
	return [
		{
			type: "session",
			version: 3,
			id: "pi-1",
			timestamp: "2026-03-01T00:00:00.000Z",
			cwd,
		},
		{
			type: "model_change",
			id: "e0",
			parentId: null,
			provider: "prov",
			modelId: "model-a",
		},
		{
			type: "message",
			id: "e1",
			parentId: "e0",
			timestamp: "2026-03-01T00:00:01.000Z",
			message: { role: "user", content: [{ type: "text", text: "first ask" }] },
		},
		{
			type: "message",
			id: "e2",
			parentId: "e1",
			message: {
				role: "assistant",
				provider: "prov",
				model: "model-a",
				content: [
					{ type: "thinking", thinking: "hmm" },
					{
						type: "toolCall",
						id: "tc1",
						name: "bash",
						arguments: { command: "go build ./..." },
					},
				],
			},
		},
		{
			type: "message",
			id: "e3",
			parentId: "e2",
			message: {
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "bash",
				isError: false,
				content: [{ type: "text", text: "" }],
			},
		},
		{
			type: "message",
			id: "abandoned",
			parentId: "e3",
			message: {
				role: "user",
				content: [{ type: "text", text: "abandoned branch prompt" }],
			},
		},
		{
			type: "message",
			id: "e4",
			parentId: "e3",
			message: {
				role: "assistant",
				provider: "prov",
				model: "model-a",
				content: [
					{
						type: "toolCall",
						id: "tc2",
						name: "bash",
						arguments: { command: "go test ./..." },
					},
				],
			},
		},
		{
			type: "message",
			id: "e5",
			parentId: "e4",
			message: {
				role: "toolResult",
				toolCallId: "tc2",
				toolName: "bash",
				isError: true,
				content: [{ type: "text", text: "FAIL\n\nCommand exited with code 1" }],
			},
		},
		{
			type: "compaction",
			id: "e6",
			parentId: "e5",
			summary: "Built the project; tests fail.",
			firstKeptEntryId: "e4",
			tokensBefore: 1000,
		},
		{
			type: "message",
			id: "e7",
			parentId: "e6",
			message: {
				role: "bashExecution",
				command: "go vet ./...",
				output: "",
				exitCode: 0,
			},
		},
		{
			type: "message",
			id: "e8",
			parentId: "e7",
			message: {
				role: "user",
				content: [{ type: "text", text: "now fix the test" }],
			},
		},
	];
}

export function grokUpdates() {
	const update = (
		sessionUpdate: string,
		fields: object,
		timestamp?: string,
	) => ({
		method: "session/update",
		params: { update: { sessionUpdate, ...fields } },
		timestamp,
	});
	return [
		update(
			"user_message_chunk",
			{ content: { type: "text", text: "run the build" } },
			"2026-04-01T00:00:00Z",
		),
		update("agent_thought_chunk", {
			content: { type: "text", text: "thinking" },
		}),
		update("agent_message_chunk", {
			content: { type: "text", text: "Running " },
		}),
		update("agent_message_chunk", {
			content: { type: "text", text: "it now." },
		}),
		update("tool_call", {
			toolCallId: "g1",
			title: "run_terminal_command",
			rawInput: { command: "cargo build" },
			_meta: { "x.ai/tool": { name: "run_terminal_command" } },
		}),
		update("tool_call_update", { toolCallId: "g1", status: "in_progress" }),
		update("tool_call_update", {
			toolCallId: "g1",
			status: "completed",
			content: [
				{ type: "content", content: { type: "text", text: "Finished" } },
			],
			rawOutput: { type: "Output", output: "Finished", exit_code: 0 },
		}),
		update("tool_call", {
			toolCallId: "g2",
			title: "edit",
			rawInput: { filePath: "src/lib.rs", oldString: "a", newString: "b" },
			_meta: { "x.ai/tool": { name: "edit" } },
		}),
		update("tool_call_update", {
			toolCallId: "g2",
			status: "completed",
			rawOutput: "edited",
		}),
		update("hook_execution", { hook: "x" }),
		update("session_recap", { summary: "Recap: building the crate." }),
	];
}

export function grokChatHistory() {
	return [
		{ type: "system", content: "system prompt" },
		{
			type: "user",
			content: [
				{ type: "text", text: "<user_query>\nlist files\n</user_query>" },
			],
		},
		{
			type: "user",
			content: [{ type: "text", text: "reminder" }],
			synthetic_reason: "system_reminder",
		},
		{
			type: "assistant",
			content: "Listing.",
			tool_calls: [{ id: "h1", name: "bash", arguments: '{"command":"ls"}' }],
		},
		{ type: "tool_result", tool_call_id: "h1", content: "a\nb" },
		{ type: "assistant", content: "Two files." },
	];
}

export function required<T>(value: T | undefined, what = "value"): T {
	if (value === undefined) throw new Error(`expected ${what}`);
	return value;
}
