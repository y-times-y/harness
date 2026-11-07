import { mcpServerLabel, mcpToolLabel } from "./connector-name";
import { CALL_MCP_TOOL_TOOL } from "./mcp-tool-call";

/** An MCP call as the transcript names it: mcp__<server>__<tool>, or call_mcp_tool's input. */
export type McpCallName = {
	server: string;
	tool: string;
	/** "Notion" for notion-notion, as Settings shows the server. */
	serverLabel: string;
	/** "Get self" for notion-get-self. */
	toolLabel: string;
};

const MCP_NAME = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/;

function parsed(text: string | undefined): unknown {
	if (!text) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);

export function mcpCallName(item: {
	tool: string;
	input?: string;
}): McpCallName | null {
	let server: string | undefined;
	let tool: string | undefined;
	const named = MCP_NAME.exec(item.tool);
	if (named) [, server, tool] = named;
	else if (item.tool === CALL_MCP_TOOL_TOOL) {
		const input = parsed(item.input);
		if (isRecord(input)) {
			server = typeof input.server === "string" ? input.server : undefined;
			tool = typeof input.tool === "string" ? input.tool : undefined;
		}
	}
	if (!server || !tool) return null;
	return mcpCallNameFor(server, tool);
}

export const mcpCallNameFor = (server: string, tool: string): McpCallName => ({
	server,
	tool,
	serverLabel: mcpServerLabel(server),
	toolLabel: mcpToolLabel(tool, server),
});

/** The arguments a call sent: call_mcp_tool nests them under "arguments". */
export function mcpCallArguments(item: {
	tool: string;
	input?: string;
}): string | undefined {
	if (item.tool !== CALL_MCP_TOOL_TOOL) return item.input;
	const input = parsed(item.input);
	return isRecord(input) && "arguments" in input
		? JSON.stringify(input.arguments ?? {})
		: item.input;
}

/** One MCP content block, ready to show. Remote images are never loaded. */
export type McpBlock =
	| { kind: "text"; text: string; markdown: boolean }
	| { kind: "json"; value: unknown }
	| { kind: "image"; src: string; mimeType: string }
	| { kind: "audio"; src: string; mimeType: string }
	| {
			kind: "link";
			uri: string;
			/** Set only for http(s) links, which open in a new tab. */
			href: string | null;
			label: string;
			description?: string;
	  }
	| {
			kind: "resource";
			uri: string;
			href: string | null;
			mimeType?: string;
			text?: string;
	  };

export type McpResult = {
	isError: boolean;
	blocks: McpBlock[];
	/** Set when the server or the record cut the output short. */
	note?: string;
};

const DISPLAY_TRUNCATED = /\n\[Output truncated for display\]$/;
const SAFE_IMAGE = /^image\/(?:png|jpe?g|gif|webp|avif|bmp|svg\+xml)$/i;
const SAFE_AUDIO = /^audio\/[\w.+-]+$/i;
const BASE64 = /^[A-Za-z0-9+/=\s]+$/;
const MARKDOWN =
	/^#{1,6} \S|^\s*(?:[-*+]|\d+\.) \S|\[[^\]\n]+\]\([^)\s]+\)|^```|\*\*[^*\n]+\*\*|^\s*\|.+\|\s*$/m;

const webHref = (uri: string) => (/^https?:\/\//i.test(uri) ? uri : null);

/** A text block: JSON when it parses to an object or array, else text (markdown when it looks like it). */
function textBlock(text: string): McpBlock {
	const trimmed = text.trim();
	if (/^[[{]/.test(trimmed)) {
		const value = parsed(trimmed);
		if (value && typeof value === "object") return { kind: "json", value };
	}
	return { kind: "text", text, markdown: MARKDOWN.test(text) };
}

function contentBlock(block: unknown): McpBlock | null {
	if (!isRecord(block)) return null;
	const mimeType = typeof block.mimeType === "string" ? block.mimeType : "";
	const data = typeof block.data === "string" ? block.data : "";
	switch (block.type) {
		case "text":
			return typeof block.text === "string" ? textBlock(block.text) : null;
		case "image":
			return SAFE_IMAGE.test(mimeType) && data && BASE64.test(data)
				? { kind: "image", src: `data:${mimeType};base64,${data}`, mimeType }
				: {
						kind: "text",
						text: `Image (${mimeType || "unknown type"})`,
						markdown: false,
					};
		case "audio":
			return SAFE_AUDIO.test(mimeType) && data && BASE64.test(data)
				? { kind: "audio", src: `data:${mimeType};base64,${data}`, mimeType }
				: {
						kind: "text",
						text: `Audio (${mimeType || "unknown type"})`,
						markdown: false,
					};
		case "resource_link": {
			const uri = typeof block.uri === "string" ? block.uri : "";
			if (!uri) return null;
			const label =
				(typeof block.title === "string" && block.title) ||
				(typeof block.name === "string" && block.name) ||
				uri;
			return {
				kind: "link",
				uri,
				href: webHref(uri),
				label,
				description:
					typeof block.description === "string" ? block.description : undefined,
			};
		}
		case "resource": {
			const resource = isRecord(block.resource) ? block.resource : null;
			const uri = typeof resource?.uri === "string" ? resource.uri : "";
			if (!resource || !uri) return null;
			const type =
				typeof resource.mimeType === "string" ? resource.mimeType : undefined;
			if (
				type &&
				SAFE_IMAGE.test(type) &&
				typeof resource.blob === "string" &&
				BASE64.test(resource.blob)
			)
				return {
					kind: "image",
					src: `data:${type};base64,${resource.blob}`,
					mimeType: type,
				};
			return {
				kind: "resource",
				uri,
				href: webHref(uri),
				mimeType: type,
				text: typeof resource.text === "string" ? resource.text : undefined,
			};
		}
		default:
			return { kind: "json", value: block };
	}
}

/**
 * An MCP call's recorded output as content blocks: the CallToolResult's
 * content (text, JSON, images, links, resources), its isError flag, and
 * a note when the output was cut. Non-MCP shapes fall back to JSON or text.
 */
export function mcpResult(output: string | undefined): McpResult | null {
	if (output === undefined || output === "") return null;
	let note: string | undefined;
	let raw = output;
	if (DISPLAY_TRUNCATED.test(raw)) {
		raw = raw.replace(DISPLAY_TRUNCATED, "");
		note = "Output was cut short";
	}
	const value = parsed(raw);
	if (value === undefined)
		return { isError: false, blocks: [textBlock(raw)], note };
	if (!isRecord(value))
		return {
			isError: false,
			blocks: [
				typeof value === "string" ? textBlock(value) : { kind: "json", value },
			],
			note,
		};
	// The server's bound on a huge result (mcp-tools.ts bounded()).
	if (value.truncated === true && typeof value.preview === "string")
		return {
			isError: false,
			blocks: [{ kind: "text", text: value.preview, markdown: false }],
			note: `Output was cut short${typeof value.originalCharacters === "number" ? ` (${value.originalCharacters.toLocaleString("en-US")} characters)` : ""}`,
		};
	const isError = value.isError === true;
	if (Array.isArray(value.content)) {
		const blocks = value.content
			.map(contentBlock)
			.filter((block): block is McpBlock => block !== null);
		if (!blocks.length && value.structuredContent !== undefined)
			blocks.push({ kind: "json", value: value.structuredContent });
		return { isError, blocks, note };
	}
	// call_mcp_tool's own refusals: { isError, error, issues?, inputSchema? }.
	if (isError && typeof value.error === "string") {
		const { error, isError: _flag, inputSchema: _schema, ...rest } = value;
		return {
			isError,
			blocks: [
				{ kind: "text", text: error, markdown: false },
				...(Object.keys(rest).length
					? [{ kind: "json" as const, value: rest }]
					: []),
			],
			note,
		};
	}
	const { _meta: _ignored, ...rest } = value;
	return { isError, blocks: [{ kind: "json", value: rest }], note };
}
