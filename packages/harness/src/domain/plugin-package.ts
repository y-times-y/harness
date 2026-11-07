import { z } from "zod";

/**
 * The .claude-plugin/plugin.json plugin format (standard layout),
 * reduced to what a cloud agent can use: skills, commands and remote (HTTP)
 * MCP servers. Everything else is reported as unsupported, never executed.
 */
export type PluginSkill = { name: string; description: string; body: string };
export type PluginCommand = {
	name: string;
	description: string;
	argumentHint?: string;
	template: string;
};
type PluginMcpServer = {
	name: string;
	url: string;
	/** Values may hold ${user_config.KEY}; resolved with the user's saved config. */
	headers: Record<string, string>;
};
type PluginUserConfigOption = {
	title: string;
	description: string;
	sensitive: boolean;
	required: boolean;
};
type ParsedPlugin = {
	name: string;
	displayName: string;
	version: string | null;
	description: string;
	skills: PluginSkill[];
	commands: PluginCommand[];
	mcpServers: PluginMcpServer[];
	userConfig: Record<string, PluginUserConfigOption>;
	unsupported: string[];
};

const MAX_BODY = 32_000;
const MAX_ITEMS = 50;
const PLUGIN_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ITEM_NAME = /^[a-z0-9][a-z0-9_-]{0,47}$/;

/** Manifest paths are relative to the plugin root, start with ./ and never escape it. */
function pluginPath(value: string) {
	if (!value.startsWith("./") && value !== ".") return null;
	const parts = value
		.replace(/^\.\/?/, "")
		.split("/")
		.filter(Boolean);
	if (parts.some((part) => part === ".." || part === ".")) return null;
	return parts.join("/");
}

function frontmatter(text: string) {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
	const fields = new Map<string, string>();
	for (const line of match?.[1].split(/\r?\n/) ?? []) {
		const field = /^([a-zA-Z-]+):\s*(.*)$/.exec(line.trim());
		if (field)
			fields.set(field[1].toLowerCase(), field[2].replace(/^["']|["']$/g, ""));
	}
	return { fields, body: (match ? text.slice(match[0].length) : text).trim() };
}

const manifestSchema = z
	.object({
		name: z.string(),
		displayName: z.string().max(80).optional(),
		version: z.string().max(40).optional(),
		description: z.string().optional(),
		skills: z.union([z.string(), z.array(z.string())]).optional(),
		commands: z
			.union([
				z.string(),
				z.array(z.string()),
				z.record(
					z.string(),
					z.object({
						source: z.string().optional(),
						content: z.string().optional(),
						description: z.string().optional(),
						argumentHint: z.string().optional(),
					}),
				),
			])
			.optional(),
		mcpServers: z.unknown().optional(),
		hooks: z.unknown().optional(),
		agents: z.unknown().optional(),
		lspServers: z.unknown().optional(),
		userConfig: z
			.record(
				z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
				z.object({
					type: z.string(),
					title: z.string(),
					description: z.string(),
					required: z.boolean().optional(),
					sensitive: z.boolean().optional(),
				}),
			)
			.optional(),
	})
	.passthrough();

/** Parses the plugin's text files (path -> contents, relative to the plugin root). */
export function parsePlugin(
	files: ReadonlyMap<string, string>,
	fallbackName: string,
): ParsedPlugin {
	const unsupported: string[] = [];
	const rawManifest = files.get(".claude-plugin/plugin.json");
	const manifest = rawManifest
		? manifestSchema.parse(JSON.parse(rawManifest))
		: manifestSchema.parse({ name: fallbackName });
	// Some published plugins capitalize their name; namespace under its kebab form.
	manifest.name = manifest.name.trim().toLowerCase().replace(/\s+/g, "-");
	if (!PLUGIN_NAME.test(manifest.name))
		throw new Error(`Plugin name "${manifest.name}" must be kebab-case.`);

	// Skills: default skills/<name>/SKILL.md plus any manifest directories.
	const skillRoots = new Set(["skills"]);
	for (const entry of [manifest.skills ?? []].flat()) {
		const path = pluginPath(entry);
		if (path === null) throw new Error(`Invalid skills path: ${entry}`);
		skillRoots.add(path);
	}
	const skills: PluginSkill[] = [];
	for (const [path, text] of files) {
		const root = [...skillRoots].find((candidate) =>
			candidate
				? path.startsWith(`${candidate}/`) &&
					path.slice(candidate.length + 1).split("/").length === 2
				: path.split("/").length === 2,
		);
		if (root === undefined || !path.endsWith("/SKILL.md")) continue;
		const { fields, body } = frontmatter(text);
		const name = fields.get("name") ?? path.split("/").at(-2) ?? "";
		if (!ITEM_NAME.test(name) || !body) continue;
		skills.push({
			name,
			description: (fields.get("description") ?? body.split("\n")[0]).slice(
				0,
				500,
			),
			body: body.slice(0, MAX_BODY),
		});
	}

	// Commands: the manifest replaces the default commands/ scan when present.
	const commands: PluginCommand[] = [];
	const addCommand = (
		name: string,
		text: string,
		overrides: { description?: string; argumentHint?: string } = {},
	) => {
		if (!ITEM_NAME.test(name)) return;
		const { fields, body } = frontmatter(text);
		if (!body) return;
		commands.push({
			name,
			description: (
				overrides.description ??
				fields.get("description") ??
				body.split("\n")[0]
			).slice(0, 200),
			argumentHint: (
				overrides.argumentHint ?? fields.get("argument-hint")
			)?.slice(0, 80),
			template: body.slice(0, MAX_BODY),
		});
	};
	const commandFiles = (directory: string) => {
		for (const [path, text] of files)
			if (
				path.startsWith(`${directory}/`) &&
				path.endsWith(".md") &&
				!path.slice(directory.length + 1).includes("/")
			)
				addCommand(path.slice(directory.length + 1, -3), text);
	};
	const declared = manifest.commands;
	if (declared === undefined) commandFiles("commands");
	else if (typeof declared === "string" || Array.isArray(declared))
		for (const entry of [declared].flat()) {
			const path = pluginPath(entry);
			if (path === null) throw new Error(`Invalid commands path: ${entry}`);
			const file = files.get(path);
			if (file !== undefined && path.endsWith(".md"))
				addCommand(path.split("/").at(-1)?.slice(0, -3) ?? "", file);
			else commandFiles(path);
		}
	else
		for (const [name, entry] of Object.entries(declared)) {
			const source = entry.source ? pluginPath(entry.source) : null;
			const text = entry.content ?? (source ? files.get(source) : undefined);
			if (text !== undefined)
				addCommand(name, text, {
					description: entry.description,
					argumentHint: entry.argumentHint,
				});
		}

	// MCP: .mcp.json first, then manifest entries; remote HTTP only.
	const serverMaps: unknown[] = [];
	const mcpFile = files.get(".mcp.json");
	// .mcp.json is either { mcpServers: { ... } } or a bare server map.
	const serverMap = (file: string) => {
		const parsed = JSON.parse(file) as { mcpServers?: unknown };
		return parsed.mcpServers ?? parsed;
	};
	if (mcpFile) serverMaps.push(serverMap(mcpFile));
	for (const entry of [manifest.mcpServers ?? []].flat()) {
		if (typeof entry === "string") {
			const path = pluginPath(entry);
			const file = path ? files.get(path) : undefined;
			if (path?.endsWith(".json") && file) serverMaps.push(serverMap(file));
			else unsupported.push(`MCP bundle or path ${entry}`);
		} else serverMaps.push(entry);
	}
	const servers = new Map<string, PluginMcpServer>();
	for (const map of serverMaps)
		for (const [rawName, raw] of Object.entries(
			(map ?? {}) as Record<string, unknown>,
		)) {
			const name = rawName.toLowerCase();
			const server = raw as {
				type?: string;
				url?: string;
				headers?: Record<string, string>;
			};
			if (
				server.type === "http" &&
				server.url?.startsWith("https://") &&
				ITEM_NAME.test(name)
			)
				servers.set(name, {
					name,
					url: server.url,
					headers: Object.fromEntries(
						Object.entries(server.headers ?? {}).filter(
							([key, value]) =>
								/^[A-Za-z0-9-]{1,64}$/.test(key) && typeof value === "string",
						),
					),
				});
			else
				unsupported.push(
					`MCP server ${name} (${server.type ?? (server.url ? "remote" : "stdio")}: only HTTPS http servers run in the cloud)`,
				);
		}

	for (const [key, label] of [
		["hooks", "hooks"],
		["agents", "agents"],
		["lspServers", "language servers"],
	] as const)
		if (manifest[key] !== undefined) unsupported.push(label);
	for (const path of files.keys())
		if (path === "hooks/hooks.json") unsupported.push("hooks");
		else if (path.startsWith("agents/")) unsupported.push("agents");
		else if (path.startsWith("bin/")) unsupported.push("executables (bin/)");

	// ${VAR} / ${VAR:-default} in MCP URLs and headers become settings to fill in.
	const settings: Record<string, PluginUserConfigOption> = {};
	for (const server of servers.values())
		for (const value of [server.url, ...Object.values(server.headers)])
			for (const match of value.matchAll(PLACEHOLDER)) {
				const [, userConfigKey, variable, fallback] = match;
				const key = userConfigKey ?? variable;
				if (!key || settings[key] || manifest.userConfig?.[key]) continue;
				settings[key] = {
					title: key,
					description: `Required by the ${server.name} MCP server`,
					sensitive: /TOKEN|KEY|SECRET|PASSWORD/i.test(key),
					required: fallback === undefined,
				};
			}
	return {
		name: manifest.name,
		displayName: manifest.displayName ?? manifest.name,
		version: manifest.version ?? null,
		description: (manifest.description ?? "").slice(0, 500),
		skills: skills.slice(0, MAX_ITEMS),
		commands: commands.slice(0, MAX_ITEMS),
		mcpServers: [...servers.values()].slice(0, MAX_ITEMS),
		userConfig: Object.fromEntries([
			...Object.entries(settings),
			...Object.entries(manifest.userConfig ?? {}).map(([key, option]) => [
				key,
				{
					title: option.title,
					description: option.description,
					sensitive: option.sensitive === true,
					required: option.required === true,
				},
			]),
		]),
		unsupported: [...new Set(unsupported)],
	};
}

const PLACEHOLDER =
	/\$\{(?:user_config\.([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?)\}/g;

/** Substitutes ${user_config.KEY}, ${VAR} and ${VAR:-default}; a missing required value is an error. */
export function resolvePluginValue(
	value: string,
	config: Record<string, string>,
) {
	return value.replace(
		PLACEHOLDER,
		(_match, userConfigKey, variable, fallback) => {
			const key = userConfigKey ?? variable;
			const resolved = config[key] || fallback;
			if (resolved === undefined)
				throw new Error(`Plugin setting "${key}" is required.`);
			return resolved;
		},
	);
}

export function resolvePluginHeaders(
	headers: Record<string, string>,
	config: Record<string, string>,
) {
	return Object.fromEntries(
		Object.entries(headers).map(([key, value]) => [
			key,
			resolvePluginValue(value, config),
		]),
	);
}
