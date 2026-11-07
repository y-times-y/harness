import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { main } from "./cli";

type Sse = [string, unknown];
const usageStart = (model: string): Sse => [
	"message_start",
	{
		type: "message_start",
		message: {
			id: "msg_1",
			type: "message",
			role: "assistant",
			model,
			content: [],
			stop_reason: null,
			usage: { input_tokens: 20, output_tokens: 1 },
		},
	},
];
const toolUse = (id: string, name: string, input: unknown): Sse[] => [
	[
		"content_block_start",
		{
			type: "content_block_start",
			index: 0,
			content_block: { type: "tool_use", id, name, input: {} },
		},
	],
	[
		"content_block_delta",
		{
			type: "content_block_delta",
			index: 0,
			delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
		},
	],
	["content_block_stop", { type: "content_block_stop", index: 0 }],
	[
		"message_delta",
		{
			type: "message_delta",
			delta: { stop_reason: "tool_use" },
			usage: { output_tokens: 8 },
		},
	],
	["message_stop", { type: "message_stop" }],
];
const answer = (text: string): Sse[] => [
	[
		"content_block_start",
		{
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		},
	],
	[
		"content_block_delta",
		{
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text },
		},
	],
	["content_block_stop", { type: "content_block_stop", index: 0 }],
	[
		"message_delta",
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { output_tokens: 9 },
		},
	],
	["message_stop", { type: "message_stop" }],
];

/** A stand-in for the Anthropic Messages API: the server's script decides each reply. */
let server: Server;
let baseUrl = "";
let respond: (payload: { model: string; toolResults: number }) => {
	status: number;
	events?: Sse[];
};
const requests: { apiKey: string | undefined; model: string }[] = [];

beforeAll(async () => {
	server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => {
			const payload = JSON.parse(body) as { model: string; messages: unknown };
			requests.push({
				apiKey: request.headers["x-api-key"] as string | undefined,
				model: payload.model,
			});
			const toolResults =
				JSON.stringify(payload.messages).match(/"type":"tool_result"/g)
					?.length ?? 0;
			const reply = respond({ model: payload.model, toolResults });
			if (reply.status !== 200) {
				response.writeHead(reply.status, {
					"content-type": "application/json",
				});
				response.end(
					JSON.stringify({
						type: "error",
						error: {
							type: "authentication_error",
							message: "invalid x-api-key",
						},
					}),
				);
				return;
			}
			response.writeHead(200, { "content-type": "text/event-stream" });
			for (const [name, data] of [
				usageStart(payload.model),
				...(reply.events ?? []),
			])
				response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
			response.end();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));

let directory: string;
beforeEach(async () => {
	requests.length = 0;
	directory = await mkdtemp(join(tmpdir(), "ytimesy-harness-cli-"));
	execFileSync("git", ["init", "-q", directory]);
	execFileSync("git", ["-C", directory, "config", "user.email", "a@b.c"]);
	execFileSync("git", ["-C", directory, "config", "user.name", "Test"]);
	await writeFile(join(directory, "notes.txt"), "alpha\n");
	execFileSync("git", ["-C", directory, "add", "."]);
	execFileSync("git", ["-C", directory, "commit", "-qm", "initial"]);
});
afterEach(() => rm(directory, { recursive: true, force: true }));

function io(env: Record<string, string>) {
	env = { PATH: process.env.PATH ?? "", ...env };
	const out: string[] = [];
	const err: string[] = [];
	return {
		out,
		err,
		io: {
			env,
			cwd: directory,
			stdout: (text: string) => out.push(text),
			stderr: (text: string) => err.push(text),
		},
	};
}

it("runs a task against an Anthropic-protocol endpoint and prints the answer", async () => {
	respond = ({ toolResults }) => ({
		status: 200,
		events:
			toolResults === 0
				? toolUse("toolu_1", "write", {
						path: "hello.txt",
						content: "hi from the model\n",
					})
				: answer("Created hello.txt."),
	});
	const run = io({ ANTHROPIC_API_KEY: "key-123" });
	const code = await main(
		["--provider", "anthropic", "--base-url", baseUrl, "Add hello.txt"],
		run.io,
	);
	expect(code).toBe(0);
	expect(run.out.join("")).toBe("Created hello.txt.\n");
	expect(run.err.join("")).toContain("• write hello.txt");
	expect(await readFile(join(directory, "hello.txt"), "utf8")).toBe(
		"hi from the model\n",
	);
	expect(requests.map((request) => request.apiKey)).toEqual([
		"key-123",
		"key-123",
	]);
});

it("picks the provider from the key in the environment and honors --model", async () => {
	respond = () => ({ status: 200, events: answer("ok") });
	const run = io({ ANTHROPIC_API_KEY: "k" });
	const code = await main(
		["--base-url", baseUrl, "--model", "claude-sonnet-5-5", "--quiet", "hi"],
		run.io,
	);
	expect(code).toBe(0);
	expect(requests[0]?.model).toBe("claude-sonnet-5-5");
	expect(run.err.join("")).toBe("");
});

it("explains a rejected key in command-line terms", async () => {
	respond = () => ({ status: 401 });
	const run = io({ ANTHROPIC_API_KEY: "bad" });
	const code = await main(
		["--provider", "anthropic", "--base-url", baseUrl, "hi"],
		run.io,
	);
	expect(code).toBe(1);
	const message = run.err.join("");
	expect(message).toContain(
		"anthropic rejected the API key in ANTHROPIC_API_KEY",
	);
	expect(message).not.toContain("Settings");
});

it("shows what the provider said when it turns a request down", async () => {
	respond = () => ({ status: 400 });
	const run = io({ ANTHROPIC_API_KEY: "secret-key-value" });
	const code = await main(
		["--provider", "anthropic", "--base-url", baseUrl, "hi"],
		run.io,
	);
	expect(code).toBe(1);
	const message = run.err.join("");
	expect(message).toContain("anthropic said: invalid x-api-key");
	expect(message).not.toContain("secret-key-value");
});

it("fails clearly with no task, no key or an unknown provider", async () => {
	const none = io({});
	expect(await main([], none.io)).toBe(2);
	expect(none.err.join("")).toContain("no task given");
	const nokey = io({});
	expect(await main(["do it"], nokey.io)).toBe(2);
	expect(nokey.err.join("")).toContain("no API key found");
	const unknown = io({ ANTHROPIC_API_KEY: "k" });
	expect(await main(["--provider", "nope", "do it"], unknown.io)).toBe(2);
	expect(unknown.err.join("")).toContain('unknown provider "nope"');
});

it("refuses clearly where the command runner cannot work, unless told to try", async () => {
	const windows = io({ ANTHROPIC_API_KEY: "k" });
	expect(
		await main(["--base-url", baseUrl, "hi"], {
			...windows.io,
			platform: "win32",
		}),
	).toBe(2);
	const message = windows.err.join("");
	expect(message).toContain("needs Linux or macOS");
	expect(message).toContain("docker run");
	// The override reaches the model.
	respond = () => ({ status: 200, events: answer("ok") });
	const forced = io({
		ANTHROPIC_API_KEY: "k",
		YTIMESY_HARNESS_ALLOW_PLATFORM: "1",
	});
	expect(
		await main(["--base-url", baseUrl, "--quiet", "hi"], {
			...forced.io,
			platform: "win32",
		}),
	).toBe(0);
});

it("goes ahead on macOS with a note that it is untested", async () => {
	respond = () => ({ status: 200, events: answer("ok") });
	const mac = io({ ANTHROPIC_API_KEY: "k" });
	expect(
		await main(["--base-url", baseUrl, "hi"], {
			...mac.io,
			platform: "darwin",
		}),
	).toBe(0);
	expect(mac.err.join("")).toContain("macOS support is new and untested");
});

it("says what is missing when python3 or bash is not installed", async () => {
	const bare = io({ ANTHROPIC_API_KEY: "k", PATH: "/nonexistent" });
	expect(await main(["--base-url", baseUrl, "hi"], bare.io)).toBe(2);
	expect(bare.err.join("")).toContain("python3 and bash are not installed");
});

it("takes harness switches and refuses the ones that need the cloud product", async () => {
	respond = () => ({ status: 200, events: answer("ok") });
	const primary = io({ ANTHROPIC_API_KEY: "k" });
	expect(
		await main(
			[
				"--base-url",
				baseUrl,
				"--variant",
				"codeMode=primary,plan=off",
				"--quiet",
				"hi",
			],
			primary.io,
		),
	).toBe(0);
	const cloud = io({ ANTHROPIC_API_KEY: "k" });
	expect(
		await main(
			["--base-url", baseUrl, "--variant", "subagents=on", "hi"],
			cloud.io,
		),
	).toBe(2);
	expect(cloud.err.join("")).toContain("subagents is not available locally");
});

it("prints usage for --help", async () => {
	const run = io({});
	expect(await main(["--help"], run.io)).toBe(0);
	expect(run.out.join("")).toContain("Usage: ytimesy-harness");
});
