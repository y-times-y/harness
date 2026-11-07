import { describe, expect, it } from "vitest";
import { mcpServerLabel, mcpToolLabel } from "./connector-name";
import { mcpCallArguments, mcpCallName, mcpResult } from "./mcp-call-view";

describe("MCP call names", () => {
	it("names the server as Settings does and the tool in plain words", () => {
		expect(mcpCallName({ tool: "mcp__notion__search_pages" })).toEqual({
			server: "notion",
			tool: "search_pages",
			serverLabel: "Notion",
			toolLabel: "Search pages",
		});
		expect(
			mcpCallName({ tool: "mcp__notion-notion__notion-get-self" }),
		).toMatchObject({ serverLabel: "Notion", toolLabel: "Get self" });
		expect(mcpCallName({ tool: "mcp__github__get_PR_diff" })).toMatchObject({
			serverLabel: "GitHub",
			toolLabel: "Get PR diff",
		});
	});

	it("reads call_mcp_tool's server, tool and nested arguments", () => {
		const item = {
			tool: "call_mcp_tool",
			input: JSON.stringify({
				server: "linear",
				tool: "listIssues",
				arguments: { team: "ENG" },
			}),
		};
		expect(mcpCallName(item)).toMatchObject({
			serverLabel: "Linear",
			toolLabel: "List issues",
		});
		expect(mcpCallArguments(item)).toBe('{"team":"ENG"}');
	});

	it("ignores tools that are not MCP calls", () => {
		expect(mcpCallName({ tool: "bash" })).toBeNull();
		expect(mcpCallName({ tool: "call_mcp_tool", input: "{}" })).toBeNull();
	});

	it("keeps multi-word server names and never strips the whole tool", () => {
		expect(mcpServerLabel("my-docs")).toBe("my-docs");
		expect(mcpToolLabel("notion", "notion")).toBe("Notion");
	});
});

describe("MCP results", () => {
	it("parses JSON text blocks and keeps prose as text", () => {
		const result = mcpResult(
			JSON.stringify({
				_meta: { "io.modelcontextprotocol/serverInfo": { name: "Notion" } },
				content: [
					{ type: "text", text: '{"results":[{"title":"Mistakes"}]}' },
					{ type: "text", text: "Found 1 page." },
					{ type: "text", text: "## Notes\n- one\n- two" },
				],
				isError: false,
			}),
		);
		expect(result).toEqual({
			isError: false,
			note: undefined,
			blocks: [
				{ kind: "json", value: { results: [{ title: "Mistakes" }] } },
				{ kind: "text", text: "Found 1 page.", markdown: false },
				{ kind: "text", text: "## Notes\n- one\n- two", markdown: true },
			],
		});
	});

	it("shows images only from inline data and links resources", () => {
		const result = mcpResult(
			JSON.stringify({
				content: [
					{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
					{ type: "image", mimeType: "text/html", data: "PGI+" },
					{
						type: "resource_link",
						uri: "https://example.com/doc",
						name: "doc",
						title: "Design doc",
					},
					{ type: "resource_link", uri: "javascript:alert(1)", name: "x" },
					{
						type: "resource",
						resource: {
							uri: "file:///a.txt",
							mimeType: "text/plain",
							text: "hi",
						},
					},
				],
			}),
		);
		expect(result?.blocks).toEqual([
			{
				kind: "image",
				src: "data:image/png;base64,iVBORw0KGgo=",
				mimeType: "image/png",
			},
			{ kind: "text", text: "Image (text/html)", markdown: false },
			{
				kind: "link",
				uri: "https://example.com/doc",
				href: "https://example.com/doc",
				label: "Design doc",
				description: undefined,
			},
			{
				kind: "link",
				uri: "javascript:alert(1)",
				href: null,
				label: "x",
				description: undefined,
			},
			{
				kind: "resource",
				uri: "file:///a.txt",
				href: null,
				mimeType: "text/plain",
				text: "hi",
			},
		]);
	});

	it("marks isError results and call_mcp_tool refusals", () => {
		expect(
			mcpResult(
				JSON.stringify({
					content: [{ type: "text", text: "Page not found" }],
					isError: true,
				}),
			),
		).toMatchObject({
			isError: true,
			blocks: [{ kind: "text", text: "Page not found" }],
		});
		expect(
			mcpResult(
				JSON.stringify({
					isError: true,
					error: "Arguments do not match fetch's input schema.",
					issues: ["id is required"],
					inputSchema: { type: "object" },
				}),
			),
		).toEqual({
			isError: true,
			note: undefined,
			blocks: [
				{
					kind: "text",
					text: "Arguments do not match fetch's input schema.",
					markdown: false,
				},
				{ kind: "json", value: { issues: ["id is required"] } },
			],
		});
	});

	it("notes outputs cut by the server or the record", () => {
		expect(
			mcpResult(
				JSON.stringify({
					truncated: true,
					originalCharacters: 120000,
					preview: '{"content":[',
				}),
			),
		).toMatchObject({
			blocks: [{ kind: "text", text: '{"content":[' }],
			note: "Output was cut short (120,000 characters)",
		});
		expect(
			mcpResult('{"content": [{"type"\n[Output truncated for display]'),
		).toMatchObject({
			note: "Output was cut short",
			blocks: [{ kind: "text" }],
		});
		expect(mcpResult(undefined)).toBeNull();
	});
});
