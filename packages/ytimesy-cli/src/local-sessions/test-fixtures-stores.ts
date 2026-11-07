// Synthetic, hand-written fixtures for the Gemini CLI, Cursor CLI and Cursor app stores.
// Shapes follow what each tool writes (see the reader module comments); no content
// comes from real sessions.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { writeJsonl } from "./test-fixtures.ts";

// ---------- Gemini CLI ----------

export function geminiHash(projectRoot: string): string {
	return crypto.createHash("sha256").update(projectRoot).digest("hex");
}

/** A slug project folder (`tmp/<slug>` with `.project_root`), registered in projects.json. */
export function geminiProject(home: string, cwd: string, slug: string): string {
	const gemini = path.join(home, ".gemini");
	const directory = path.join(gemini, "tmp", slug);
	fs.mkdirSync(path.join(directory, "chats"), { recursive: true });
	fs.writeFileSync(path.join(directory, ".project_root"), cwd);
	const registryFile = path.join(gemini, "projects.json");
	const registry = fs.existsSync(registryFile)
		? JSON.parse(fs.readFileSync(registryFile, "utf8"))
		: { projects: {} };
	registry.projects[cwd.toLowerCase()] = slug;
	fs.writeFileSync(registryFile, JSON.stringify(registry));
	return directory;
}

const shellCall = (
	id: string,
	command: string,
	output: string,
	status = "success",
) => ({
	id,
	name: "run_shell_command",
	args: { command, description: "run it", dir_path: "." },
	result: [
		{
			functionResponse: {
				id,
				name: "run_shell_command",
				response: { output },
			},
		},
	],
	status,
	timestamp: "2026-10-30T10:00:05.000Z",
	resultDisplay: output,
	displayName: "Shell",
});

/** Gemini CLI 0.40 JSONL: re-appended messages, $set, $rewindTo, info, a subagent-free session. */
export function geminiJsonlRecords(projectRoot: string) {
	const user1 = {
		id: "m-user-1",
		timestamp: "2026-10-30T10:00:00.000Z",
		type: "user",
		content: [{ text: "Fix the failing test in src/app.ts" }],
	};
	const gemini1Partial = {
		id: "m-gem-1",
		timestamp: "2026-10-30T10:00:03.000Z",
		type: "gemini",
		content: "I'll look at the test first.",
		thoughts: [
			{
				subject: "Plan",
				description: "Read the test",
				timestamp: "2026-10-30T10:00:02.000Z",
			},
		],
		model: "gemini-3-pro",
	};
	const gemini1Full = {
		...gemini1Partial,
		toolCalls: [
			shellCall(
				"call-1",
				"npm test",
				"Output: 1 failing\nError: tests failed\nExit Code: 1\nProcess Group PGID: 4242",
			),
			{
				id: "call-2",
				name: "replace",
				args: {
					file_path: `${projectRoot}/src/app.ts`,
					old_string: "a",
					new_string: "b",
				},
				result: [
					{
						functionResponse: {
							id: "call-2",
							name: "replace",
							response: { output: "Successfully modified file" },
						},
					},
				],
				status: "success",
				timestamp: "2026-10-30T10:00:06.000Z",
			},
			shellCall(
				"call-3",
				"npm test",
				"Output: all passed\nProcess Group PGID: 4243",
			),
		],
	};
	const rewound = {
		id: "m-user-rewound",
		timestamp: "2026-10-30T10:00:07.000Z",
		type: "user",
		content: [{ text: "this prompt was rewound away" }],
	};
	return [
		{
			sessionId: "gem-session-1",
			projectHash: geminiHash(projectRoot),
			startTime: "2026-10-30T10:00:00.000Z",
			lastUpdated: "2026-10-30T10:00:00.000Z",
			kind: "main",
		},
		user1,
		{ $set: { lastUpdated: "2026-10-30T10:00:01.000Z" } },
		gemini1Partial,
		gemini1Full,
		rewound,
		{ $rewindTo: "m-user-rewound" },
		{
			id: "m-info",
			timestamp: "2026-10-30T10:00:08.000Z",
			type: "info",
			content: "Chat history compressed from 1000 to 200 tokens.",
		},
		{
			id: "m-user-2",
			timestamp: "2026-10-30T10:00:09.000Z",
			type: "user",
			content: [{ text: "expanded @file content" }],
			displayContent: [{ text: "Now commit it" }],
		},
		{
			id: "m-gem-2",
			timestamp: "2026-10-30T10:00:10.000Z",
			type: "gemini",
			content: "Committed.",
			model: "gemini-3-flash",
		},
		{ $set: { summary: "Fix failing app test" } },
		"{not json",
	];
}

/** Legacy single-JSON session (before JSONL), shell output in the older always-printed format. */
export function geminiLegacySession(projectRoot: string) {
	return {
		sessionId: "gem-legacy-1",
		projectHash: geminiHash(projectRoot),
		startTime: "2025-08-01T09:00:00.000Z",
		lastUpdated: "2025-08-01T09:05:00.000Z",
		messages: [
			{
				id: "l1",
				timestamp: "2025-08-01T09:00:00.000Z",
				type: "user",
				content: "List the files",
			},
			{
				id: "l2",
				timestamp: "2025-08-01T09:00:02.000Z",
				type: "gemini",
				content: "",
				toolCalls: [
					shellCall(
						"lc1",
						"ls",
						"Command: ls\nDirectory: (root)\nStdout: a b\nStderr: (empty)\nError: (none)\nExit Code: 0\nSignal: (none)",
					),
				],
				model: "gemini-2.5-pro",
			},
		],
	};
}

/** `/chat save` checkpoint: Gemini API history. */
export function geminiCheckpointHistory() {
	return [
		{ role: "user", parts: [{ text: "Run the build" }] },
		{
			role: "model",
			parts: [
				{ text: "Running it." },
				{
					functionCall: {
						id: "cp1",
						name: "run_shell_command",
						args: { command: "make" },
					},
				},
			],
		},
		{
			role: "user",
			parts: [
				{
					functionResponse: {
						id: "cp1",
						name: "run_shell_command",
						response: { output: "Output: ok\nExit Code: 2" },
					},
				},
			],
		},
	];
}

export function writeGeminiJsonl(
	directory: string,
	name: string,
	records: unknown[],
): string {
	const file = path.join(directory, "chats", name);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(
		file,
		`${records.map((record) => (typeof record === "string" ? record : JSON.stringify(record))).join("\n")}\n`,
	);
	return file;
}

// ---------- Cursor blob store (CLI store.db and app agentKv) ----------

function varint(value: number): Buffer {
	const bytes: number[] = [];
	let remaining = value;
	while (remaining >= 0x80) {
		bytes.push((remaining % 0x80) | 0x80);
		remaining = Math.floor(remaining / 0x80);
	}
	bytes.push(remaining);
	return Buffer.from(bytes);
}

function lengthField(field: number, value: Buffer): Buffer {
	return Buffer.concat([varint(field * 8 + 2), varint(value.length), value]);
}

/** Conversation root protobuf: field 1 per message id, field 9 workspace URI, field 26 a time. */
export function encodeRoot(
	messageIds: string[],
	workspaceUri?: string,
): Buffer {
	const parts = messageIds.map((id) => lengthField(1, Buffer.from(id, "hex")));
	if (workspaceUri) parts.push(lengthField(9, Buffer.from(workspaceUri)));
	parts.push(Buffer.concat([varint(26 * 8), varint(1793560527592)]));
	parts.push(lengthField(22, Buffer.from("cli")));
	return Buffer.concat(parts);
}

export function blobId(data: Buffer | string): string {
	return crypto.createHash("sha256").update(data).digest("hex");
}

/** AI SDK message blobs as the Cursor agent runtime writes them. */
export function cursorBlobMessages(cwd: string) {
	return [
		{
			role: "system",
			content: "You are an AI coding assistant.",
			providerOptions: {
				cursor: {
					systemPromptFingerprint: {
						model: "fixture-model-1",
						agentType: "cli",
					},
				},
			},
		},
		{
			role: "user",
			content: `<user_info>\nOS Version: linux\nWorkspace Path: ${cwd}\n</user_info>\n<rules>\n<user_rule>be brief</user_rule>\n</rules>`,
		},
		{
			role: "user",
			content: [
				{
					type: "text",
					text: "<timestamp>Sunday, Nov 1, 2026, 11:15 AM (UTC-8)</timestamp>\n<user_query>\nRun the tests and fix notes.txt\n</user_query>",
				},
			],
		},
		{
			role: "assistant",
			id: "a1",
			content: [
				{ type: "reasoning", text: "Run tests first", signature: "sig" },
				{
					type: "tool-call",
					toolCallId: "t1",
					toolName: "Shell",
					args: { command: "npm test", description: "Run tests" },
				},
				{
					type: "tool-call",
					toolCallId: "t2",
					toolName: "Shell",
					args: { command: "ls /missing", description: "List" },
				},
			],
		},
		{
			role: "tool",
			id: "r1",
			content: [
				{
					type: "tool-result",
					toolCallId: "t1",
					toolName: "Shell",
					result: "Exit code: 0\n\nCommand output:\n\n```\nok\n```",
				},
			],
			providerOptions: {
				cursor: {
					highLevelToolCallResult: {
						output: { success: { command: "npm test", stdout: "ok\n" } },
						isError: false,
					},
				},
			},
		},
		{
			role: "tool",
			id: "r2",
			content: [
				{
					type: "tool-result",
					toolCallId: "t2",
					toolName: "Shell",
					result:
						"Exit code: 1\n\nCommand output:\n\n```\nls: /missing: No such file\n```",
				},
			],
			providerOptions: {
				cursor: {
					highLevelToolCallResult: {
						output: { failure: { command: "ls /missing", exitCode: 1 } },
						isError: false,
					},
				},
			},
		},
		{
			role: "assistant",
			id: "a2",
			content: [
				{
					type: "tool-call",
					toolCallId: "t3",
					toolName: "StrReplace",
					args: {
						path: `${cwd}/notes.txt`,
						old_string: "hello",
						new_string: "bye",
					},
				},
			],
		},
		{
			role: "tool",
			id: "r3",
			content: [
				{
					type: "tool-result",
					toolCallId: "t3",
					toolName: "StrReplace",
					result: "ok",
				},
			],
		},
		{ role: "assistant", id: "a3", content: [{ type: "text", text: "Done." }] },
	];
}

export interface BlobSet {
	ids: string[];
	blobs: Map<string, Buffer>;
}

export function blobSet(messages: unknown[]): BlobSet {
	const blobs = new Map<string, Buffer>();
	const ids = messages.map((message) => {
		const data = Buffer.from(JSON.stringify(message));
		const id = blobId(data);
		blobs.set(id, data);
		return id;
	});
	return { ids, blobs };
}

/** A Cursor CLI chat: `<config>/chats/<md5(cwd)>/<id>/{meta.json, store.db}`. */
export function writeCursorAgentChat(
	home: string,
	cwd: string,
	chatId: string,
	options: {
		messages?: unknown[];
		withMeta?: boolean;
		metaOverrides?: object;
		storeMeta?: "hex" | "missing";
		updatedAtMs?: number;
	} = {},
): string {
	const hash = crypto.createHash("md5").update(path.resolve(cwd)).digest("hex");
	const directory = path.join(home, ".cursor", "chats", hash, chatId);
	fs.mkdirSync(directory, { recursive: true });
	const { ids, blobs } = blobSet(options.messages ?? cursorBlobMessages(cwd));
	const root = encodeRoot(ids, `file://${cwd}`);
	const rootId = blobId(root);
	blobs.set(rootId, root);
	const database = new DatabaseSync(path.join(directory, "store.db"));
	database.exec(
		"CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);",
	);
	const insert = database.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)");
	for (const [id, data] of blobs) insert.run(id, data);
	if (options.storeMeta !== "missing") {
		const meta = {
			agentId: chatId,
			latestRootBlobId: rootId,
			name: "New Agent",
			mode: "default",
			createdAt: 1793560524054,
		};
		database
			.prepare("INSERT INTO meta (key, value) VALUES (?, ?)")
			.run("0", Buffer.from(JSON.stringify(meta)).toString("hex"));
	}
	database.close();
	if (options.withMeta !== false) {
		fs.writeFileSync(
			path.join(directory, "meta.json"),
			JSON.stringify({
				schemaVersion: 1,
				createdAtMs: 1793560524054,
				hasConversation: true,
				updatedAtMs: options.updatedAtMs ?? 1793560530151,
				cwd,
				...options.metaOverrides,
			}),
		);
	}
	return directory;
}

// ---------- Cursor app (state.vscdb) ----------

export interface CursorAppFixture {
	userDirectory: string;
	stateFile: string;
}

/** Linux layout: `~/.config/Cursor/User/{globalStorage,workspaceStorage}`. */
export function createCursorApp(home: string): CursorAppFixture {
	const userDirectory = path.join(home, ".config", "Cursor", "User");
	const globalDirectory = path.join(userDirectory, "globalStorage");
	fs.mkdirSync(globalDirectory, { recursive: true });
	const stateFile = path.join(globalDirectory, "state.vscdb");
	const database = new DatabaseSync(stateFile);
	database.exec(`
		CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
		CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
		CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER, recency INTEGER, checkpointAt INTEGER, value TEXT, subagentTypeName TEXT);
	`);
	database.close();
	return { userDirectory, stateFile };
}

export function putKv(stateFile: string, key: string, value: unknown): void {
	const database = new DatabaseSync(stateFile);
	database
		.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)")
		.run(
			key,
			typeof value === "string" || Buffer.isBuffer(value)
				? value
				: JSON.stringify(value),
		);
	database.close();
}

export function putHeader(
	stateFile: string,
	composerId: string,
	workspaceId: string,
): void {
	const database = new DatabaseSync(stateFile);
	database
		.prepare(
			"INSERT INTO composerHeaders (composerId, workspaceId, createdAt, value) VALUES (?, ?, ?, ?)",
		)
		.run(
			composerId,
			workspaceId,
			1,
			JSON.stringify({ type: "head", composerId }),
		);
	database.close();
}

/** `workspaceStorage/<id>/{workspace.json, state.vscdb}` listing the workspace's composers. */
export function addCursorWorkspace(
	app: CursorAppFixture,
	workspaceId: string,
	folder: string,
	composerIds: string[],
): void {
	const directory = path.join(
		app.userDirectory,
		"workspaceStorage",
		workspaceId,
	);
	fs.mkdirSync(directory, { recursive: true });
	fs.writeFileSync(
		path.join(directory, "workspace.json"),
		JSON.stringify({ folder: `file://${folder}` }),
	);
	const database = new DatabaseSync(path.join(directory, "state.vscdb"));
	database.exec(
		"CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
	);
	database.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
		"composer.composerData",
		JSON.stringify({
			allComposers: composerIds.map((composerId) => ({
				type: "head",
				composerId,
			})),
			selectedComposerIds: [],
		}),
	);
	database.close();
}

/** Composer `_v` 10 with bubble rows: shell (exit omitted = 0, exit 1, rejected), edit, summary. */
export function bubbleComposer(
	app: CursorAppFixture,
	composerId: string,
	cwd: string,
): void {
	const bubbles = [
		{
			_v: 3,
			type: 1,
			bubbleId: "b1",
			text: "Make the build pass",
			createdAt: "2026-10-01T10:00:00.000Z",
		},
		{
			_v: 3,
			type: 2,
			bubbleId: "b2",
			text: "",
			createdAt: "2026-10-01T10:00:02.000Z",
			modelInfo: { modelName: "fixture-app-model" },
			toolFormerData: {
				tool: 15,
				name: "run_terminal_command_v2",
				toolCallId: "tc1",
				status: "completed",
				params: JSON.stringify({ command: "npm run build", cwd }),
				result: JSON.stringify({ output: "built", rejected: false }),
			},
		},
		{
			_v: 3,
			type: 2,
			bubbleId: "b3",
			text: "",
			createdAt: "2026-10-01T10:00:03.000Z",
			toolFormerData: {
				tool: 15,
				name: "run_terminal_command_v2",
				toolCallId: "tc2",
				status: "completed",
				params: JSON.stringify({ command: "npm test", cwd }),
				result: JSON.stringify({
					output: "1 failed",
					exitCode: 1,
					rejected: false,
				}),
			},
		},
		{
			_v: 3,
			type: 2,
			bubbleId: "b4",
			text: "",
			createdAt: "2026-10-01T10:00:04.000Z",
			toolFormerData: {
				tool: 15,
				name: "run_terminal_cmd",
				toolCallId: "tc3",
				status: "completed",
				params: JSON.stringify({
					command: "rm -rf /",
					requireUserApproval: true,
				}),
				result: JSON.stringify({ rejected: true }),
			},
		},
		{
			_v: 3,
			type: 2,
			bubbleId: "b5",
			text: "",
			createdAt: "2026-10-01T10:00:05.000Z",
			toolFormerData: {
				tool: 38,
				name: "edit_file_v2",
				toolCallId: "tc4",
				status: "completed",
				params: JSON.stringify({
					relativeWorkspacePath: "src/build.ts",
					streamingContent: "x",
				}),
				result: JSON.stringify({}),
			},
		},
		{
			_v: 3,
			type: 2,
			bubbleId: "b6",
			text: "Fixed the build.",
			createdAt: "2026-10-01T10:00:06.000Z",
			conversationSummary: {
				summary: "Earlier: set up the project.",
				truncationLastBubbleIdInclusive: "b1",
			},
		},
	];
	putKv(app.stateFile, `composerData:${composerId}`, {
		_v: 10,
		composerId,
		name: "Build fix",
		createdAt: 1790000000000,
		lastUpdatedAt: 1790000100000,
		modelConfig: { modelName: "default" },
		fullConversationHeadersOnly: [
			...bubbles.map((bubble) => ({
				bubbleId: bubble.bubbleId,
				type: bubble.type,
			})),
			{ bubbleId: "missing-bubble", type: 2 },
		],
		conversationMap: {},
	});
	for (const bubble of bubbles)
		putKv(app.stateFile, `bubbleId:${composerId}:${bubble.bubbleId}`, bubble);
}

/** Oldest shape: no `_v`, conversation inline. */
export function inlineComposer(
	app: CursorAppFixture,
	composerId: string,
): void {
	putKv(app.stateFile, `composerData:${composerId}`, {
		composerId,
		createdAt: 1700000000000,
		conversation: [
			{ type: 1, bubbleId: "i1", text: "What does main.py do?" },
			{ type: 2, bubbleId: "i2", text: "It prints hello." },
		],
	});
}

/** `_v` 18 agent chat with no bubbles: conversationState root + agentKv blobs. */
export function blobComposer(
	app: CursorAppFixture,
	composerId: string,
	cwd: string,
): void {
	const { ids, blobs } = blobSet(cursorBlobMessages(cwd));
	for (const [id, data] of blobs)
		putKv(app.stateFile, `agentKv:blob:${id}`, data);
	const root = encodeRoot(ids, `file://${cwd}`);
	putKv(app.stateFile, `composerData:${composerId}`, {
		_v: 18,
		composerId,
		name: "Agent chat",
		createdAt: 1795000000000,
		lastUpdatedAt: 1795000100000,
		fullConversationHeadersOnly: [],
		conversationState: `~${root.toString("base64")}`,
		workspaceIdentifier: {
			id: "ws-x",
			uri: { fsPath: cwd, path: cwd, scheme: "file" },
		},
	});
}

export function emptyComposer(app: CursorAppFixture, composerId: string): void {
	putKv(app.stateFile, `composerData:${composerId}`, {
		_v: 10,
		composerId,
		createdAt: 1799000000000,
		fullConversationHeadersOnly: [],
	});
}

/** A future shape this reader does not know: no conversation fields at all. */
export function futureComposer(
	app: CursorAppFixture,
	composerId: string,
): void {
	putKv(app.stateFile, `composerData:${composerId}`, {
		_v: 99,
		composerId,
		createdAt: 1798000000000,
		turnsV2: { opaque: true },
	});
}

export { writeJsonl };
