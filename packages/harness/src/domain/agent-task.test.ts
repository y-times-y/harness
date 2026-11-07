import { describe, expect, it } from "vitest";
import { agentTaskTree, turnPublicationRole } from "./agent-task";

describe("agentTaskTree", () => {
	it("keeps the brief and derives a finished status from the turn", () => {
		const [task] = agentTaskTree("root", [
			{
				id: "child",
				parentSessionId: "root",
				title: "Implement bounded change",
				taskPrompt: "Exact original contract",
				turnStatus: "completed",
				harness: "codex",
				listedModelId: "model",
				createdAt: "2026-09-21T12:01:00.000Z",
				updatedAt: "2026-09-21T12:01:00.000Z",
			},
		]);
		expect(task).toMatchObject({ id: "child", status: "done" });
		expect(task.prompt).toBe("Exact original contract");
	});
	it("numbers recursive tasks by their position under each parent", () => {
		const tasks = agentTaskTree("root", [
			{
				id: "child-2",
				parentSessionId: "root",
				title: "Tests",
				turnStatus: "idle",
				harness: "codex",
				listedModelId: "codex/model",
				createdAt: "2026-09-21T12:01:00.000Z",
				updatedAt: "2026-09-21T12:01:00.000Z",
			},
			{
				id: "grandchild",
				parentSessionId: "child-1",
				title: "Adapters",
				turnStatus: "running",
				harness: "codex",
				listedModelId: null,
				createdAt: "2026-09-21T12:02:00.000Z",
				updatedAt: "2026-09-21T12:02:00.000Z",
			},
			{
				id: "child-1",
				parentSessionId: "root",
				title: "Audit",
				turnStatus: "completed",
				harness: "codex",
				listedModelId: null,
				createdAt: "2026-09-21T12:00:00.000Z",
				updatedAt: "2026-09-21T12:03:00.000Z",
			},
		]);

		expect(
			tasks.map(({ label, title, depth, status }) => ({
				label,
				title,
				depth,
				status,
			})),
		).toEqual([
			{ label: "Task 1", title: "Audit", depth: 1, status: "done" },
			{
				label: "Task 1.1",
				title: "Adapters",
				depth: 2,
				status: "working",
			},
			{ label: "Task 2", title: "Tests", depth: 1, status: "idle" },
		]);
	});
});

describe("turnPublicationRole", () => {
	const base = { providerRef: "vm", parentSessionId: null };
	it("publishes every root chat as a chat", () => {
		expect(turnPublicationRole(base)).toBe("chat");
	});
	it("never publishes a subagent", () => {
		expect(turnPublicationRole({ ...base, parentSessionId: "builder" })).toBe(
			null,
		);
	});
	it("never publishes without a machine", () => {
		expect(turnPublicationRole({ ...base, providerRef: null })).toBe(null);
	});
});
