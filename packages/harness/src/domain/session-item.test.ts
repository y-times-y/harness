import { describe, expect, it } from "vitest";
import { SessionItemId } from "./ids";
import {
	chatHeaderTitle,
	compactTimelineItems,
	composerSubmitTarget,
	continuedChatAwaitsMessage,
	fileChangesFromSessionItems,
	isQueuedUserMessage,
	isTurnRunning,
	lastAgentMessageText,
	lastUserMessageText,
	markedQueuedSend,
	type SessionItem,
	sendWasQueued,
	sessionItemsQueuedWithUser,
	sessionTitleFromItems,
	sessionUsesFollowUpLayout,
	sessionViewAfterRecovery,
	sessionViewShouldReplaceOpenTurn,
	sessionWithoutFailedSend,
	visibleSessionItems,
	withQueuedUserMessages,
} from "./session-item";

describe("session items", () => {
	it("does not treat a completed turn as still running", () => {
		expect(isTurnRunning("running")).toBe(true);
		expect(isTurnRunning("completed")).toBe(false);
		expect(isTurnRunning("idle")).toBe(false);
	});

	it("collects file paths only from fileChange items", () => {
		const items: SessionItem[] = [
			{
				kind: "agentMessage",
				id: SessionItemId("msg-1"),
				text: "edited README",
			},
			{
				kind: "fileChange",
				id: SessionItemId("patch-1"),
				status: "completed",
				changes: [
					{
						path: "README.md",
						change: "update",
						additions: 4,
						deletions: 1,
						preview: "--- a/README.md\n+setup\n",
					},
					{
						path: "src/app.ts",
						change: "add",
						additions: 12,
						deletions: 0,
						preview: "export {}\n",
					},
				],
			},
		];

		expect(fileChangesFromSessionItems(items)).toEqual([
			{
				path: "README.md",
				change: "update",
				additions: 4,
				deletions: 1,
				preview: "--- a/README.md\n+setup\n",
			},
			{
				path: "src/app.ts",
				change: "add",
				additions: 12,
				deletions: 0,
				preview: "export {}\n",
			},
		]);
	});

	it("keeps the latest preview when the same path is edited again", () => {
		const items: SessionItem[] = [
			{
				kind: "fileChange",
				id: SessionItemId("patch-1"),
				status: "completed",
				changes: [
					{
						path: "todo.py",
						change: "add",
						additions: 10,
						deletions: 0,
						preview: "print(1)\n",
					},
				],
			},
			{
				kind: "fileChange",
				id: SessionItemId("patch-2"),
				status: "completed",
				changes: [
					{
						path: "todo.py",
						change: "update",
						additions: 2,
						deletions: 1,
						preview: "print(2)\n",
					},
				],
			},
		];

		expect(fileChangesFromSessionItems(items)).toEqual([
			{
				path: "todo.py",
				change: "update",
				additions: 2,
				deletions: 1,
				preview: "print(2)\n",
			},
		]);
	});

	it("keeps a local user message until the server transcript includes it", () => {
		const server: SessionItem[] = [
			{
				kind: "userMessage",
				id: SessionItemId("user-1"),
				text: "first",
			},
		];
		const optimistic: SessionItem[] = [
			{
				kind: "userMessage",
				id: SessionItemId("local-2"),
				text: "second",
			},
		];

		expect(visibleSessionItems(server, optimistic)).toHaveLength(2);
		expect(
			visibleSessionItems(server, [
				{ kind: "userMessage", id: SessionItemId("user-1"), text: "first" },
			]),
		).toEqual(server);
		// The same words sent again are a new message, not the earlier one.
		expect(
			visibleSessionItems(server, [
				{ kind: "userMessage", id: SessionItemId("local-1"), text: "first" },
			]),
		).toHaveLength(2);
	});

	it("returns the most recent user message for retry", () => {
		const items: SessionItem[] = [
			{
				kind: "userMessage",
				id: SessionItemId("user-1"),
				text: "first",
			},
			{
				kind: "agentMessage",
				id: SessionItemId("msg-1"),
				text: "ok",
			},
			{
				kind: "userMessage",
				id: SessionItemId("user-2"),
				text: "second",
			},
		];
		expect(lastUserMessageText(items)).toBe("second");
		expect(
			lastUserMessageText([
				{
					kind: "userMessage",
					id: SessionItemId("user-1"),
					text: "What is this repository?",
				},
				{
					kind: "userMessage",
					id: SessionItemId("preamble"),
					text: "You are in a ytimesy workspace VM. The project checkout is /home/ubuntu; work there.\n\nWhat is this repository?",
				},
			]),
		).toBe("What is this repository?");
	});

	it("reads the latest agent reply for briefing traces", () => {
		expect(
			lastAgentMessageText([
				{
					kind: "userMessage",
					id: SessionItemId("user-1"),
					text: "Seal the snapshot",
				},
				{
					kind: "agentMessage",
					id: SessionItemId("agent-1"),
					text: "Wrote template_snapshot_id.",
				},
			]),
		).toBe("Wrote template_snapshot_id.");
	});

	it("uses the first line of the latest user message as the session title", () => {
		expect(sessionTitleFromItems([])).toBe("New session");
		expect(
			sessionTitleFromItems([
				{
					kind: "userMessage",
					id: SessionItemId("user-1"),
					text: "fix the composer\nmore detail",
				},
			]),
		).toBe("fix the composer");
	});

	it("keeps reasoning interleaved with tools the way a cloud agent view does", () => {
		expect(
			compactTimelineItems([
				{
					kind: "userMessage",
					id: SessionItemId("user-1"),
					text: "create hero",
				},
				{
					kind: "reasoning",
					id: SessionItemId("r1"),
					summaries: ["first"],
					durationSeconds: 4,
				},
				{
					kind: "agentMessage",
					id: SessionItemId("m0"),
					text: "I’ll create the file.",
				},
				{
					kind: "commandExecution",
					id: SessionItemId("cmd-1"),
					command: `mkdir -p /tmp/src && cat > /tmp/src/hero.tsx <<'EOF'\nexport const hero = { title: "ytimesy" };\nEOF`,
					cwd: "/tmp",
					status: "completed",
					output: null,
					exitCode: 0,
				},
				{
					kind: "reasoning",
					id: SessionItemId("r2"),
					summaries: ["second"],
					durationSeconds: 1,
				},
				{
					kind: "agentMessage",
					id: SessionItemId("m1"),
					text: "ok",
				},
			]).map((item) => item.kind),
		).toEqual([
			"userMessage",
			"reasoning",
			"agentMessage",
			"fileChange",
			"reasoning",
			"agentMessage",
		]);
	});

	it("hides the internal workspace preamble from the transcript", () => {
		expect(
			compactTimelineItems([
				{
					kind: "userMessage",
					id: SessionItemId("user-1"),
					text: "What is this repository?",
				},
				{
					kind: "userMessage",
					id: SessionItemId("user-preamble"),
					text: "You are in a ytimesy workspace VM. The project checkout is /home/ubuntu/ytimesy; work there.\n\nWhat is this repository?",
				},
			]).map((item) => item.id),
		).toEqual([SessionItemId("user-1")]);
	});

	it("collects Diff files from shell heredoc writes", () => {
		expect(
			fileChangesFromSessionItems([
				{
					kind: "commandExecution",
					id: SessionItemId("cmd-1"),
					command: `cat > src/hero.tsx <<'EOF'\nexport const hero = { title: "ytimesy" };\nEOF`,
					cwd: "/tmp",
					status: "completed",
					output: null,
					exitCode: 0,
				},
			]),
		).toEqual([
			{
				path: "src/hero.tsx",
				change: "add",
				additions: 1,
				deletions: 0,
				preview: 'export const hero = { title: "ytimesy" };',
			},
		]);
	});

	it("keeps the tall composer until the user actually starts a turn", () => {
		expect(sessionUsesFollowUpLayout({ items: [], turnStatus: "idle" })).toBe(
			false,
		);
		expect(
			sessionUsesFollowUpLayout({
				items: [
					{
						kind: "userMessage",
						id: SessionItemId("user-1"),
						text: "fix the composer",
					},
				],
				turnStatus: "idle",
			}),
		).toBe(true);
		expect(
			sessionUsesFollowUpLayout({ items: [], turnStatus: "running" }),
		).toBe(true);
		expect(
			sessionUsesFollowUpLayout({
				items: [],
				turnStatus: "idle",
				listedTitle: "fix the composer",
			}),
		).toBe(true);
		expect(
			sessionUsesFollowUpLayout({
				items: [],
				turnStatus: "idle",
				listedTitle: "New session",
			}),
		).toBe(false);
	});
});

it("records a plan approval only while a plan waits, even with repeated words", () => {
	const plan = {
		kind: "planProposal" as const,
		id: SessionItemId("t1:plan"),
		text: "1. Do it",
	};
	const [, approval] = sessionItemsQueuedWithUser(
		[plan],
		"Approved. Implement the plan.",
		"m1",
		true,
	);
	expect(approval).toMatchObject({
		kind: "userMessage",
		approvesPlan: true,
	});
	// A second plan approved with the same words is a new message.
	const again = sessionItemsQueuedWithUser(
		[plan, approval, { ...plan, id: SessionItemId("t2:plan") }],
		"Approved. Implement the plan.",
		"m2",
		true,
	);
	expect(again).toHaveLength(4);
	// Nothing waits: a replayed approval is a duplicate.
	expect(
		sessionItemsQueuedWithUser(
			[plan, approval],
			"Approved. Implement the plan.",
			"m3",
			true,
		),
	).toHaveLength(2);
	const [plain] = sessionItemsQueuedWithUser([], "Refactor auth", "m4");
	expect(plain).not.toHaveProperty("approvesPlan");
});

describe("message identity", () => {
	const user = (id: string, text = "continue"): SessionItem => ({
		kind: "userMessage",
		id: SessionItemId(id),
		text,
	});
	const reply = (id: string): SessionItem => ({
		kind: "agentMessage",
		id: SessionItemId(id),
		text: "done",
	});

	it("queues a deliberate repeat but not a replayed send", () => {
		const first = sessionItemsQueuedWithUser([], "continue", "m1");
		const repeat = sessionItemsQueuedWithUser(first, "continue", "m2");
		expect(repeat).toHaveLength(2);
		expect(sessionItemsQueuedWithUser(repeat, "continue", "m2")).toEqual(
			repeat,
		);
		expect(sendWasQueued(repeat, "m2")).toBe(true);
		expect(sendWasQueued(repeat, "m3")).toBe(false);
		expect(sendWasQueued(repeat, undefined)).toBe(false);
	});

	it("takes back a send the server refused and unlocks the turn", () => {
		const session = {
			items: [user("m1"), reply("a1"), user("m2")],
			turnStatus: "running" as const,
		};
		expect(sessionWithoutFailedSend(session, "m2", "completed")).toEqual({
			items: [user("m1"), reply("a1")],
			turnStatus: "completed",
		});
		// A send that never reached the transcript leaves it alone.
		expect(sessionWithoutFailedSend(session, "m9", "idle")).toBe(session);
	});

	it("keeps the open turn against a view from before the send", () => {
		const open = [user("m1"), reply("a1"), user("m2")];
		const stale = [user("m1"), reply("a1")];
		expect(
			sessionViewShouldReplaceOpenTurn({
				currentStatus: "running",
				nextStatus: "completed",
				currentItems: open,
				nextItems: stale,
			}),
		).toBe(false);
		// A repeated "continue": the earlier, settled one is not this turn.
		expect(
			sessionViewShouldReplaceOpenTurn({
				currentStatus: "running",
				nextStatus: "idle",
				currentItems: [...stale, user("m2")],
				nextItems: [user("m1")],
			}),
		).toBe(false);
		expect(
			sessionViewShouldReplaceOpenTurn({
				currentStatus: "running",
				nextStatus: "completed",
				currentItems: open,
				nextItems: [...open, reply("a2")],
			}),
		).toBe(true);
	});

	it("unlocks the composer when a stopped turn ends idle", () => {
		const open = [user("m1")];
		// Stop pressed: the idle view counts even without the live stream.
		expect(
			sessionViewShouldReplaceOpenTurn({
				currentStatus: "running",
				nextStatus: "idle",
				currentItems: open,
				nextItems: [],
				stopRequested: true,
			}),
		).toBe(true);
		// The server holds this very message and says nothing runs.
		expect(
			sessionViewShouldReplaceOpenTurn({
				currentStatus: "running",
				nextStatus: "idle",
				currentItems: open,
				nextItems: open,
			}),
		).toBe(true);
		// Opened as running with nothing sent from here: the server decides.
		expect(
			sessionViewShouldReplaceOpenTurn({
				currentStatus: "running",
				nextStatus: "idle",
				currentItems: [],
				nextItems: open,
			}),
		).toBe(true);
	});
});

describe("composer submit target", () => {
	it("keeps a follow-up in the chat whose turn is running", () => {
		expect(
			composerSubmitTarget({
				newChatDraft: true,
				openChatId: "chat",
				turnStatus: "running",
			}),
		).toEqual({ startsNewChat: false, sessionId: "chat" });
	});
	it("does not open a second chat while a turn is on screen without an id yet", () => {
		expect(
			composerSubmitTarget({
				newChatDraft: false,
				turnStatus: "running",
			}),
		).toEqual({ startsNewChat: false, waitForChat: true });
	});
	it("starts a chat from the new-chat draft once nothing is running", () => {
		expect(
			composerSubmitTarget({
				newChatDraft: true,
				turnStatus: "idle",
			}),
		).toEqual({ startsNewChat: true });
		expect(
			composerSubmitTarget({
				newChatDraft: false,
				openChatId: "chat",
				turnStatus: "completed",
			}),
		).toEqual({ startsNewChat: false, sessionId: "chat" });
	});
});

describe("queued user messages", () => {
	const delivered: SessionItem = {
		kind: "userMessage",
		id: SessionItemId("a"),
		text: "Fix it",
	};
	it("lists waiting messages after the transcript until the transcript holds them", () => {
		const waiting = [
			{ kind: "userMessage" as const, id: SessionItemId("a"), text: "Fix it" },
			{
				kind: "userMessage" as const,
				id: SessionItemId("b"),
				text: "Also docs",
			},
		];
		const items = withQueuedUserMessages([delivered], waiting);
		expect(items.map((item) => item.id)).toEqual(["a", "b"]);
		expect(items.filter(isQueuedUserMessage).map((item) => item.id)).toEqual([
			"b",
		]);
	});
	it("marks the browser's own copy of a send made during a run", () => {
		expect(
			markedQueuedSend([delivered], "a").filter(isQueuedUserMessage),
		).toHaveLength(1);
	});
});

describe("chatHeaderTitle", () => {
	it("names the chat as the sidebar does once it has a title", () => {
		expect(chatHeaderTitle("Fix the login loop", "Now add tests")).toBe(
			"Fix the login loop",
		);
	});
	it("falls back to the latest message before the list has a title", () => {
		expect(chatHeaderTitle(undefined, "Fix the login loop")).toBe(
			"Fix the login loop",
		);
		expect(chatHeaderTitle("New session", "Fix it")).toBe("Fix it");
		expect(chatHeaderTitle("  ", "Fix it")).toBe("Fix it");
	});
});

describe("sessionViewAfterRecovery", () => {
	const items: SessionItem[] = [
		{ kind: "userMessage", id: SessionItemId("first"), text: "Implement" },
		{ kind: "agentMessage", id: SessionItemId("answer"), text: "Done" },
	];
	const open = {
		agentSessionId: "chat-1",
		items,
		turnStatus: "completed" as const,
		title: "Chat",
	};

	it("shows a restored transcript of the open chat at once instead of blanking it", () => {
		expect(sessionViewAfterRecovery(open, { id: "chat-1", items: [] })).toEqual(
			{ ...open, items: [], turnStatus: "idle" },
		);
	});

	it("keeps the transcript for a code-only restore and switches chats for a fork", () => {
		expect(sessionViewAfterRecovery(open, { id: "chat-1", items: null })).toBe(
			open,
		);
		expect(
			sessionViewAfterRecovery(open, { id: "fork-1", items: [] }),
		).toBeNull();
	});
});

describe("continued chats", () => {
	const handoff = {
		kind: "handoff" as const,
		id: SessionItemId("handoff-1"),
		tool: "claude" as const,
		title: "",
		turns: 3,
		at: "2026-11-01T00:00:00Z",
		context: "",
	};
	it("invite continuing until the first message is sent", () => {
		expect(continuedChatAwaitsMessage([handoff])).toBe(true);
		expect(
			continuedChatAwaitsMessage([
				handoff,
				{ kind: "userMessage", id: SessionItemId("u1"), text: "Go on" },
			]),
		).toBe(false);
		expect(continuedChatAwaitsMessage([])).toBe(false);
	});
});

it("finds the chat's message held for setup among its waiting ones", async () => {
	const { heldForSetupMessage, withQueuedUserMessages } = await import(
		"./session-item"
	);
	const { SessionItemId: id } = await import("./ids");
	const items = withQueuedUserMessages(
		[],
		[
			{ kind: "userMessage", id: id("a"), text: "queued" },
			{ kind: "userMessage", id: id("b"), text: "held", heldForSetup: true },
		],
	);
	expect(heldForSetupMessage(items)).toMatchObject({ id: "b", queued: true });
	expect(heldForSetupMessage(items.slice(0, 1))).toBeNull();
});

it("keeps a released held message shown until the transcript holds it, never twice", async () => {
	const { itemsKeepingMessageInFlight, messageDelivered } = await import(
		"./session-item"
	);
	const { SessionItemId: id } = await import("./ids");
	const held = {
		kind: "userMessage" as const,
		id: id("m"),
		text: "Reply with just the word HELD.",
		queued: true as const,
		heldForSetup: true as const,
	};
	// Taken from the chat's waiting row, not yet in its turn: kept as it was.
	expect(itemsKeepingMessageInFlight([held], [], "m")).toEqual([held]);
	expect(messageDelivered([held], "m")).toBe(false);
	// Released, still waiting: the read's copy shows.
	const released = {
		...held,
		heldForSetup: undefined,
		released: true as const,
	};
	expect(itemsKeepingMessageInFlight([held], [released], "m")).toEqual([
		released,
	]);
	// In the turn: once, as sent, with the answer after it.
	const sent = { kind: "userMessage" as const, id: id("m"), text: held.text };
	const answer = { kind: "agentMessage" as const, id: id("a"), text: "HELD" };
	const delivered = itemsKeepingMessageInFlight([held], [sent, answer], "m");
	expect(delivered).toEqual([sent, answer]);
	expect(messageDelivered(delivered, "m")).toBe(true);
	// A message taken back here stays gone.
	expect(itemsKeepingMessageInFlight([], [], "m")).toEqual([]);
});
