import { describe, expect, it } from "vitest";
import { SessionItemId } from "./ids";
import { type SessionItem, showTurnWorking } from "./session-item";
import { settledTurnItems } from "./turn-end";
import {
	SAVING_CHANGES_TEXT,
	savingChangesItem,
	turnMayHaveChangedWorkspace,
	turnSavingChanges,
} from "./turn-saving";

const user: SessionItem = {
	kind: "userMessage",
	id: SessionItemId("user"),
	text: "hi",
};
const answer: SessionItem = {
	kind: "agentMessage",
	id: SessionItemId("turn:reply"),
	text: "Hello.",
};
const toolCall = (id: string, tool: string): SessionItem => ({
	kind: "dynamicToolCall",
	id: SessionItemId(id),
	tool,
	status: "completed",
});

describe("turnMayHaveChangedWorkspace", () => {
	it("is false for a turn that only answered, asked or searched", () => {
		expect(turnMayHaveChangedWorkspace([user, answer], "turn")).toBe(false);
		expect(
			turnMayHaveChangedWorkspace(
				[
					user,
					{ kind: "webSearch", id: SessionItemId("turn:search"), query: "x" },
					{
						kind: "planProposal",
						id: SessionItemId("turn:plan"),
						text: "Plan",
					},
					answer,
				],
				"turn",
			),
		).toBe(false);
	});

	it("is false for the lean read-only tools", () => {
		expect(
			turnMayHaveChangedWorkspace(
				[user, toolCall("turn:a", "read"), toolCall("turn:b", "Grep"), answer],
				"turn",
			),
		).toBe(false);
	});

	it("is true for any other tool call, command, file change or MCP call of this turn", () => {
		for (const item of [
			toolCall("turn:step-1:a", "bash"),
			toolCall("turn:a", "run_code"),
			toolCall("turn:a", "apply_patch"),
			{
				kind: "commandExecution",
				id: SessionItemId("turn:a"),
				command: "ls",
				cwd: null,
				status: "completed",
				output: null,
				exitCode: 0,
			},
			{
				kind: "fileChange",
				id: SessionItemId("turn:a"),
				status: "completed",
				changes: [],
			},
			{
				kind: "mcpToolCall",
				id: SessionItemId("turn:a"),
				server: "s",
				tool: "t",
				status: "completed",
			},
		] satisfies SessionItem[])
			expect(
				turnMayHaveChangedWorkspace([user, item, answer], "turn"),
				item.kind,
			).toBe(true);
	});

	it("ignores earlier turns' tool calls", () => {
		expect(
			turnMayHaveChangedWorkspace(
				[toolCall("earlier:a", "bash"), user, answer],
				"turn",
			),
		).toBe(false);
	});
});

describe("Saving changes…", () => {
	const saving = savingChangesItem("turn");

	it("shows while the running turn commits, with messages sent meanwhile after it", () => {
		expect(saving).toMatchObject({ message: SAVING_CHANGES_TEXT });
		expect(turnSavingChanges([user, answer, saving], "running")).toBe(true);
		expect(
			turnSavingChanges(
				[
					user,
					answer,
					saving,
					{
						kind: "userMessage",
						id: SessionItemId("next"),
						text: "and then?",
						queued: true,
					},
				],
				"running",
			),
		).toBe(true);
		// It replaces the turn's "Thinking" line.
		expect(showTurnWorking([user, answer, saving], "running")).toBe(false);
	});

	it("is not shown once the turn ended or before it answered", () => {
		expect(turnSavingChanges([user, answer, saving], "completed")).toBe(false);
		expect(turnSavingChanges([user, answer], "running")).toBe(false);
		expect(turnSavingChanges([saving, user], "running")).toBe(false);
	});

	it("is dropped from a settled turn", () => {
		expect(
			settledTurnItems([user, answer, saving], Date.now()).map(
				(item) => item.id,
			),
		).toEqual([user.id, answer.id]);
	});
});
