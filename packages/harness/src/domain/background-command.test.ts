import { describe, expect, it } from "vitest";
import { applyApiProgress } from "./api-progress";
import {
	backgroundCommandLabel,
	backgroundCommandNotice,
	backgroundCommandStateText,
	runningBackgroundCommands,
	withBackgroundCommandExits,
} from "./background-command";
import { SessionItemId } from "./ids";
import type { SessionItem } from "./session-item";

const id = "0b6f7a52-41c4-4d0e-9a51-5f3c1a1e2d01";
const other = "9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
const card = (
	commandId: string,
	startedAt: number,
	extra: object = {},
): SessionItem => ({
	kind: "dynamicToolCall",
	id: SessionItemId(`turn:${commandId}`),
	tool: "bash",
	status: "completed",
	background: { id: commandId, label: "npm run dev", startedAt, ...extra },
});

describe("background commands", () => {
	it("labels a command by its first meaningful line, without a leading cd", () => {
		expect(backgroundCommandLabel("cd web && npm run dev")).toBe("npm run dev");
		expect(backgroundCommandLabel("# start\n\n  sleep 5; echo hi\nmore")).toBe(
			"sleep 5; echo hi",
		);
		expect(backgroundCommandLabel("x".repeat(100))).toHaveLength(60);
		expect(backgroundCommandLabel("   ")).toBe("command");
	});

	it("shows the live state: running for, exited 0, failed with the code", () => {
		const startedAt = 1_000_000;
		expect(
			backgroundCommandStateText(
				{ id, label: "l", startedAt },
				startedAt + 185_000,
			),
		).toBe("running 3m");
		expect(
			backgroundCommandStateText(
				{ id, label: "l", startedAt, exitCode: 0, endedAt: startedAt + 1 },
				0,
			),
		).toBe("exited 0");
		expect(
			backgroundCommandStateText(
				{ id, label: "l", startedAt, exitCode: 2, endedAt: startedAt + 1 },
				0,
			),
		).toBe("failed (exit 2)");
	});

	it("reads the running commands per chat, without exited or expired ones", () => {
		const now = 10_000_000;
		const items = [
			card(id, now - 60_000),
			card(other, now - 120_000, { exitCode: 0, endedAt: now - 1 }),
			card("old", now - 7 * 3600_000),
		];
		expect(runningBackgroundCommands(items, now, 6 * 3600)).toEqual([
			{ id, label: "npm run dev", startedAt: now - 60_000, status: "running" },
		]);
	});

	it("records an exit on its card and appends a quiet line only when it was announced", () => {
		const items = [card(id, 0), card(other, 0)];
		const next = withBackgroundCommandExits(items, [
			{
				id,
				label: "npm run dev",
				startedAt: 0,
				endedAt: 90_000,
				exitCode: 1,
				outputPath: "/tmp/out",
				lastLines: "boom",
				announced: true,
			},
			{
				id: other,
				label: "npm run dev",
				startedAt: 0,
				endedAt: 5_000,
				exitCode: 130,
				outputPath: "/tmp/out2",
				lastLines: "",
				announced: false,
			},
		]);
		expect(next).toHaveLength(3);
		expect(next[0]).toMatchObject({
			background: { exitCode: 1, endedAt: 90_000 },
		});
		expect(next[1]).toMatchObject({ background: { exitCode: 130 } });
		expect(next[2]).toMatchObject({
			kind: "notice",
			background: true,
			message: "Background: npm run dev failed (exit 1) after 1m",
		});
		// Already recorded: nothing changes.
		expect(
			withBackgroundCommandExits(next, [
				{
					id,
					label: "x",
					startedAt: 0,
					endedAt: 1,
					exitCode: 1,
					outputPath: "",
					lastLines: "",
					announced: true,
				},
			]),
		).toBe(next);
	});

	it("writes a short, bounded notice", () => {
		const notice = backgroundCommandNotice({
			id,
			label: "sleep 5; echo done",
			startedAt: 0,
			endedAt: 65_000,
			exitCode: 0,
			outputPath: "/tmp/o.stdout",
			lastLines: `${"x".repeat(5000)}\ndone`,
		});
		expect(notice).toMatch(
			new RegExp(
				`^Background command ${id} \\(sleep 5; echo done\\) finished with exit 0 after 1m; output: /tmp/o.stdout; last lines:\\n…`,
			),
		);
		expect(notice.endsWith("done")).toBe(true);
		expect(notice.length).toBeLessThan(1500);
	});

	it("marks the card of a tool call that started a background command", () => {
		const call = applyApiProgress([], "turn", {
			type: "tool-call",
			id: "c1",
			name: "bash",
			input: { command: "cd web && npm run dev", background: true },
		});
		const result = applyApiProgress(call, "turn", {
			type: "tool-result",
			id: "c1",
			name: "bash",
			output: {
				id,
				status: "running",
				command: "cd web && npm run dev",
				output: "",
				outputPath: "/tmp/x",
				wallSeconds: 0,
				background: true,
			},
		});
		expect(result[0]).toMatchObject({
			kind: "dynamicToolCall",
			background: { id, label: "npm run dev" },
		});
		const foreground = applyApiProgress(call, "turn", {
			type: "tool-result",
			id: "c1",
			name: "bash",
			output: {
				id,
				status: "running",
				command: "make",
				output: "",
				outputPath: "/tmp/x",
				wallSeconds: 0,
			},
		});
		expect(foreground[0]).not.toHaveProperty("background");
	});
});
