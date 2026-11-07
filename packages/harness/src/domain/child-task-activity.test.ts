import { expect, it } from "vitest";
import {
	childTaskAnchorId,
	childTaskEventQueueText,
	childTaskPromptId,
	childTaskPublicItems,
	isWakeTurnStart,
	withoutWakeTurnStarts,
} from "./child-task-activity";
import { SessionItemId } from "./ids";
import { type SessionItem, sessionItemsQueuedWithUser } from "./session-item";
import { settledTurnItems } from "./turn-end";

it("hides internal wakeups and historical forwarded results without hiding ordinary chat", () => {
	const items: SessionItem[] = [
		{
			kind: "userMessage",
			id: SessionItemId("ask"),
			text: "Fix the branch picker",
		},
		{
			kind: "userMessage",
			id: SessionItemId("event"),
			text: childTaskEventQueueText("1"),
		},
		{
			kind: "userMessage",
			id: SessionItemId("native"),
			text: `${childTaskEventQueueText("1")}\nEvidence`,
		},
		{
			kind: "userMessage",
			id: SessionItemId("legacy"),
			text: "Fix branch names finished. Its final summary is below:\n\nEvidence\n\nInspect its evidence and diff before accepting or publishing the result.",
		},
		{
			kind: "agentMessage",
			id: SessionItemId("answer"),
			text: "I reviewed the implementation and its tests.",
		},
	];
	// Each hidden turn start becomes a silent wake notice: no user bubble, but
	// the timeline still sees where the turn before it ended.
	expect(
		childTaskPublicItems(items).map((item) => [item.id, item.kind]),
	).toEqual([
		["ask", "userMessage"],
		["event", "notice"],
		["native", "notice"],
		["legacy", "notice"],
		["answer", "agentMessage"],
	]);
	expect(
		childTaskPublicItems(items)
			.filter(isWakeTurnStart)
			.map((item) => item.id),
	).toEqual(["event", "native", "legacy"]);
	expect(withoutWakeTurnStarts(items).map((item) => item.id)).toEqual([
		"ask",
		"answer",
	]);
	expect(JSON.stringify(childTaskPublicItems(items))).not.toContain(
		"ytimesy-child-event",
	);
});

it("keeps a wake-up turn's timing on its silent start", () => {
	const items = sessionItemsQueuedWithUser([], childTaskEventQueueText("e1"));
	const [start] = childTaskPublicItems(settledTurnItems(items, Date.now()));
	expect(start).toMatchObject({ kind: "notice", wake: true, message: "" });
	expect(start?.kind === "notice" && start.timing?.completedAt).toBeTypeOf(
		"number",
	);
});

it("keeps a child attached to the prompt that started it after a follow-up", () => {
	const items: SessionItem[] = [
		{
			kind: "userMessage",
			id: SessionItemId("first"),
			text: "Fix it",
			timing: { startedAt: 1000 },
		},
		{
			kind: "userMessage",
			id: SessionItemId("followup"),
			text: "Another task",
			timing: { startedAt: 3000 },
		},
	];
	expect(
		childTaskPromptId({ createdAt: new Date(2000).toISOString() }, items),
	).toBe("first");
});

it("anchors historical children to their creation tool without prompt timestamps", () => {
	const items: SessionItem[] = [
		{ kind: "userMessage", id: SessionItemId("first"), text: "Hi" },
		{ kind: "agentMessage", id: SessionItemId("hi"), text: "Hello" },
		{ kind: "userMessage", id: SessionItemId("second"), text: "Fix it" },
		{
			kind: "dynamicToolCall",
			id: SessionItemId("create"),
			tool: "create_task",
			status: "completed",
			output: JSON.stringify({ taskId: "child" }),
		},
		{ kind: "userMessage", id: SessionItemId("third"), text: "Another task" },
	];
	expect(
		childTaskPromptId(
			{ id: "child", createdAt: new Date(2000).toISOString() },
			items,
		),
	).toBe("second");
	expect(
		childTaskAnchorId(
			{ id: "child", createdAt: new Date(2000).toISOString() },
			items,
		),
	).toBe("create");
});

it("does not incorrectly pin untraceable legacy children to the first prompt", () => {
	expect(
		childTaskPromptId({ createdAt: new Date(2000).toISOString() }, [
			{ kind: "userMessage", id: SessionItemId("first"), text: "Hi" },
		]),
	).toBeUndefined();
});

it("anchors every batched child to its launch card rather than another prompt", () => {
	const items: SessionItem[] = [
		{
			kind: "userMessage",
			id: SessionItemId("prompt"),
			text: "Implement the feature",
		},
		{
			kind: "dynamicToolCall",
			id: SessionItemId("batch"),
			tool: "launch_ready_tasks",
			status: "completed",
			output: JSON.stringify({
				tasks: [
					{ id: "first", result: { taskId: "a" } },
					{ id: "second", result: { taskId: "b" } },
				],
			}),
		},
		{
			kind: "userMessage",
			id: SessionItemId("later"),
			text: "Another request",
		},
	];
	for (const id of ["a", "b"]) {
		const task = { id, createdAt: new Date(2000).toISOString() };
		expect(childTaskPromptId(task, items)).toBe("prompt");
		expect(childTaskAnchorId(task, items)).toBe("batch");
	}
});
