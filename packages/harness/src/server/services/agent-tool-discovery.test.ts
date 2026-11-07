import { jsonSchema, tool } from "ai";
import { expect, it } from "vitest";
import { discoverableAgentTools } from "./agent-tool-discovery";

const definition = () =>
	tool({
		inputSchema: jsonSchema({ type: "object", properties: {} }),
		execute: async () => ({}),
	});

it("sends every tool from the first request with its executor, without mutating the input", () => {
	const names = [
		"apply_patches",
		"run_checks",
		"browser_open",
		"read_project_memory",
		"report_task_blocked",
	];
	const tools = Object.fromEntries(names.map((name) => [name, definition()]));
	const offered = discoverableAgentTools(tools);
	for (const name of names) {
		expect(offered[name].deferLoading).toBe(false);
		expect(offered[name].execute).toBe(tools[name].execute);
		expect(tools[name].deferLoading).toBeUndefined();
	}
	expect(offered.search_tools).toBeDefined();
	expect(offered.create_file).toBeUndefined();
});

it("does not create a tool surface for tool-free turns", () => {
	expect(discoverableAgentTools({})).toEqual({});
});

it("sends a set of only provider-hosted tools as given, with no search_tools", async () => {
	const { openai } = await import("@ai-sdk/openai");
	const tools = { web_search: openai.tools.webSearch({}) };
	expect(discoverableAgentTools(tools)).toBe(tools);
});
