// biome-ignore-all lint/suspicious/noTemplateCurlyInString: plugin configs use literal ${user_config.KEY} placeholders.
import { expect, it } from "vitest";
import {
	parsePlugin,
	resolvePluginHeaders,
	resolvePluginValue,
} from "./plugin-package";

const files = (entries: Record<string, string>) =>
	new Map(Object.entries(entries));

it("reads skills, commands and HTTP MCP servers and flags what the cloud cannot run", () => {
	const plugin = parsePlugin(
		files({
			".claude-plugin/plugin.json": JSON.stringify({
				name: "linear-tools",
				displayName: "Linear Tools",
				version: "1.2.0",
				description: "Work with Linear issues",
				userConfig: {
					api_token: {
						type: "string",
						title: "API token",
						description: "Linear API key",
						sensitive: true,
						required: true,
					},
				},
			}),
			"skills/triage/SKILL.md":
				"---\nname: triage\ndescription: Triage new issues\n---\nRead the issue, label it, assign an owner.",
			"skills/nested/deeper/SKILL.md": "ignored: too deep",
			"commands/standup.md":
				"---\ndescription: Daily standup\n---\nSummarize my issues for $ARGUMENTS.",
			".mcp.json": JSON.stringify({
				mcpServers: {
					linear: {
						type: "http",
						url: "https://mcp.linear.app/mcp",
						headers: { Authorization: "Bearer ${user_config.api_token}" },
					},
					local: { command: "node", args: ["server.js"] },
					insecure: { type: "http", url: "http://example.com/mcp" },
				},
			}),
			"hooks/hooks.json": "{}",
			"agents/reviewer.md": "agent",
		}),
		"fallback",
	);
	expect(plugin).toMatchObject({
		name: "linear-tools",
		displayName: "Linear Tools",
		version: "1.2.0",
		skills: [{ name: "triage", description: "Triage new issues" }],
		commands: [
			{
				name: "standup",
				description: "Daily standup",
				template: "Summarize my issues for $ARGUMENTS.",
			},
		],
		mcpServers: [
			{
				name: "linear",
				url: "https://mcp.linear.app/mcp",
				headers: { Authorization: "Bearer ${user_config.api_token}" },
			},
		],
		userConfig: { api_token: { sensitive: true, required: true } },
	});
	expect(plugin.unsupported.join(" | ")).toMatch(/local.*stdio/);
	expect(plugin.unsupported.join(" | ")).toMatch(/insecure/);
	expect(plugin.unsupported).toEqual(
		expect.arrayContaining(["hooks", "agents"]),
	);
});

it("uses the manifest's command map and refuses paths that escape the plugin", () => {
	const plugin = parsePlugin(
		files({
			".claude-plugin/plugin.json": JSON.stringify({
				name: "deploy-tools",
				commands: {
					about: { content: "Explain this plugin.", description: "About" },
				},
			}),
			"commands/ignored.md": "replaced by the manifest map",
		}),
		"x",
	);
	expect(plugin.commands.map((command) => command.name)).toEqual(["about"]);
	expect(() =>
		parsePlugin(
			files({
				".claude-plugin/plugin.json": JSON.stringify({
					name: "bad",
					skills: "../outside",
				}),
			}),
			"x",
		),
	).toThrow("Invalid skills path");
	expect(
		parsePlugin(
			files({
				".claude-plugin/plugin.json": JSON.stringify({ name: "Bad Name" }),
			}),
			"x",
		).name,
	).toBe("bad-name");
	expect(() =>
		parsePlugin(
			files({
				".claude-plugin/plugin.json": JSON.stringify({ name: "bad@name" }),
			}),
			"x",
		),
	).toThrow("kebab-case");
	expect(
		parsePlugin(files({ "commands/hi.md": "Say hi" }), "no-manifest").name,
	).toBe("no-manifest");
});

it("fills ${user_config.KEY} in headers and requires every referenced value", () => {
	expect(
		resolvePluginHeaders(
			{ Authorization: "Bearer ${user_config.api_token}" },
			{ api_token: "abc" },
		),
	).toEqual({ Authorization: "Bearer abc" });
	expect(() =>
		resolvePluginHeaders(
			{ Authorization: "Bearer ${user_config.api_token}" },
			{},
		),
	).toThrow("api_token");
});

it("reads bare .mcp.json server maps and turns ${VAR} placeholders into settings", () => {
	const plugin = parsePlugin(
		files({
			".claude-plugin/plugin.json": JSON.stringify({ name: "GitHub" }),
			".mcp.json": JSON.stringify({
				github: {
					type: "http",
					url: "https://mcp.example.com/mcp/",
					headers: { Authorization: "Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}" },
				},
				dd: {
					type: "http",
					url: "https://${DD_DOMAIN:-mcp.datadoghq.com}/v1/mcp",
				},
			}),
		}),
		"x",
	);
	expect(plugin.name).toBe("github");
	expect(plugin.mcpServers.map((server) => server.name)).toEqual([
		"github",
		"dd",
	]);
	expect(plugin.userConfig).toMatchObject({
		GITHUB_PERSONAL_ACCESS_TOKEN: { sensitive: true, required: true },
		DD_DOMAIN: { required: false },
	});
	expect(
		resolvePluginValue("https://${DD_DOMAIN:-mcp.datadoghq.com}/v1/mcp", {}),
	).toBe("https://mcp.datadoghq.com/v1/mcp");
	expect(
		resolvePluginHeaders(
			{ Authorization: "Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}" },
			{ GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_x" },
		),
	).toEqual({ Authorization: "Bearer ghp_x" });
});
