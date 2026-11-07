import { type ToolSet, tool } from "ai";
import { z } from "zod";
import type { PluginSkill } from "../../domain/plugin-package";

type InstalledPlugin = { plugin: string; skills: PluginSkill[] };

/** One line per skill in the system prompt; bodies load only when the agent asks. */
export function pluginSkillsInstructions(plugins: readonly InstalledPlugin[]) {
	const lines = plugins.flatMap(({ plugin, skills }) =>
		skills.map((skill) => `- ${plugin}:${skill.name}: ${skill.description}`),
	);
	return lines.length
		? `Installed plugin skills (load one with read_plugin_skill when it applies):\n${lines.join("\n")}`
		: "";
}

export function pluginSkillTools(plugins: readonly InstalledPlugin[]): ToolSet {
	if (!plugins.some((plugin) => plugin.skills.length)) return {};
	return {
		read_plugin_skill: tool({
			description:
				"Read the full instructions of an installed plugin skill listed in your instructions.",
			inputSchema: z.object({ plugin: z.string(), skill: z.string() }),
			execute: async ({ plugin, skill }) => {
				const found = plugins
					.find((candidate) => candidate.plugin === plugin)
					?.skills.find((candidate) => candidate.name === skill);
				return found
					? { plugin, skill, instructions: found.body }
					: { error: `No installed skill ${plugin}:${skill}.` };
			},
		}),
	};
}
