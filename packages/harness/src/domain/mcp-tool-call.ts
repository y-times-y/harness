/** Searches the connected MCP servers' tools when their schemas are not offered inline. */
export const SEARCH_MCP_TOOLS_TOOL = "search_mcp_tools";
/** Calls one MCP tool by server and tool name with server-side argument validation. */
export const CALL_MCP_TOOL_TOOL = "call_mcp_tool";

/** Provider tool names allow [A-Za-z0-9_-] up to 64 characters. */
export const mcpToolName = (server: string, tool: string) =>
	`mcp__${server}__${tool.replace(/[^A-Za-z0-9_-]/g, "_")}`.slice(0, 64);

/** The MCP tool a call_mcp_tool input names, as the transcript records it. */
export function calledMcpTool(input: unknown) {
	if (!input || typeof input !== "object") return null;
	const { server, tool, arguments: args } = input as Record<string, unknown>;
	if (typeof server !== "string" || typeof tool !== "string") return null;
	return { name: mcpToolName(server, tool), arguments: args ?? {} };
}
