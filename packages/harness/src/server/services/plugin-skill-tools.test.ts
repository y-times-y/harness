import { expect, it } from "vitest";
import {
	pluginSkillsInstructions,
	pluginSkillTools,
} from "./plugin-skill-tools";

const plugins = [
	{
		plugin: "linear-tools",
		skills: [
			{
				name: "triage",
				description: "Triage new issues",
				body: "Label and assign.",
			},
		],
	},
];
const options = {
	toolCallId: "c",
	messages: [],
	abortSignal: new AbortController().signal,
	context: {},
};

it("lists plugin skills in one line each and loads a body only on request", async () => {
	expect(pluginSkillsInstructions(plugins)).toContain(
		"- linear-tools:triage: Triage new issues",
	);
	expect(pluginSkillsInstructions(plugins)).not.toContain("Label and assign.");
	const tools = pluginSkillTools(plugins);
	expect(
		await tools.read_plugin_skill.execute?.(
			{ plugin: "linear-tools", skill: "triage" },
			options,
		),
	).toEqual({
		plugin: "linear-tools",
		skill: "triage",
		instructions: "Label and assign.",
	});
	expect(
		await tools.read_plugin_skill.execute?.(
			{ plugin: "x", skill: "y" },
			options,
		),
	).toEqual({
		error: "No installed skill x:y.",
	});
});

it("adds nothing when no plugin has skills", () => {
	expect(pluginSkillsInstructions([])).toBe("");
	expect(pluginSkillTools([{ plugin: "p", skills: [] }])).toEqual({});
});
