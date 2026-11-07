import { expect, it } from "vitest";
import { SessionItemId } from "./ids";
import { publicToolDetail, toolActivity, toolOutputText } from "./tool-detail";

it("redacts credentials while preserving inspectable tool evidence", () => {
	const detail = publicToolDetail({
		command: "pnpm test",
		api_key: "private",
		nested: { access_token: "private" },
		stdout: "Bearer private sk-1234567890123456",
	});
	expect(detail).toContain("pnpm test");
	expect(detail).not.toContain("private");
	expect(detail).not.toContain("sk-1234567890123456");
	expect(JSON.parse(detail).api_key).toBe("[redacted]");
	expect(publicToolDetail("API_KEY=private")).not.toContain("private");
});

it("bounds display output without hiding that it was truncated", () => {
	expect(publicToolDetail("x".repeat(20000)).length).toBeLessThan(16100);
	expect(publicToolDetail("x".repeat(20000))).toContain("truncated");
});

it("renders captured shell results as readable output, not escaped JSON", () => {
	expect(
		toolOutputText(
			JSON.stringify({
				type: "json",
				value: { stdout: "first\nsecond", stderr: "", exitCode: 0 },
			}),
		),
	).toBe("first\nsecond\nexit 0");
	expect(
		toolOutputText(JSON.stringify({ type: "text", value: "file contents" })),
	).toBe("file contents");
});

it("marks a command left running as a background start", () => {
	const call = (input: object, output?: string) =>
		toolActivity({
			kind: "dynamicToolCall",
			id: SessionItemId("c"),
			tool: "bash",
			input: JSON.stringify(input),
			...(output ? { output } : {}),
			status: "completed",
		});
	expect(call({ command: "pnpm dev", run_in_background: true })).toMatchObject({
		verb: "Started",
		background: true,
	});
	expect(
		call(
			{ command: "pnpm build" },
			"Still running after 120 seconds. Command running in background with ID: 3.",
		),
	).toMatchObject({ background: true });
	expect(call({ command: "ls" }).background).toBeUndefined();
	// The lean command tool's background start, and a recorded command.
	expect(call({ command: "pnpm dev", background: true }).background).toBe(true);
	expect(
		toolActivity({
			kind: "dynamicToolCall",
			id: SessionItemId("d"),
			tool: "bash",
			input: JSON.stringify({ command: "pnpm dev" }),
			status: "completed",
			background: { id: "b1", label: "pnpm dev", startedAt: 0 },
		}).background,
	).toBe(true);
});

it("labels a secret request by its one name or its count", () => {
	const asked = (input: unknown) =>
		toolActivity({
			kind: "dynamicToolCall",
			id: SessionItemId("turn:secret"),
			tool: "request_project_secret",
			input: JSON.stringify(input),
			status: "completed",
		});
	expect(asked({ name: "STRIPE_KEY" })).toMatchObject({
		verb: "Asked for secret",
		target: "STRIPE_KEY",
	});
	expect(asked({ secrets: [{ name: "STRIPE_KEY" }] })).toMatchObject({
		target: "STRIPE_KEY",
	});
	expect(asked({ secrets: [{ name: "A" }, { name: "B" }] })).toMatchObject({
		verb: "Asked for",
		target: "2 secrets",
	});
});

it("labels a web_fetch call with the page it fetched", () => {
	expect(
		toolActivity({
			kind: "dynamicToolCall",
			id: SessionItemId("turn:fetch"),
			tool: "web_fetch",
			status: "completed",
			input: JSON.stringify({ url: "https://docs.example.com/api/" }),
		}),
	).toMatchObject({ verb: "Fetched", target: "docs.example.com/api" });
});
