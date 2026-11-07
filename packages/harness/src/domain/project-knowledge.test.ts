import { expect, it } from "vitest";
import {
	BUILDER_PROJECT_KNOWLEDGE_INSTRUCTIONS,
	knowledgeForTask,
	PROJECT_KNOWLEDGE_CONTEXT_LIMIT,
	PROJECT_KNOWLEDGE_LIMIT,
	type ProjectKnowledgeEntry,
	projectMemoryMaintenance,
	searchProjectKnowledge,
	updateProjectKnowledge,
} from "./project-knowledge";

const branch: ProjectKnowledgeEntry = {
	key: "branch-selection",
	title: "Branch selection",
	content:
		"Already implemented; inspect the current checkout before replacing it.",
	sources: ["repo/src/branch.ts"],
	status: "tested",
};

it("maintains named Markdown entries without dropping earlier capabilities", () => {
	let document = "Legacy briefing retained.";
	for (let index = 0; index < 8; index++)
		document = updateProjectKnowledge(document, {
			...branch,
			key: `feature-${index}`,
			title: `Feature ${index}`,
		});
	document = updateProjectKnowledge(document, {
		...branch,
		key: "feature-0",
		content: "Corrected implementation location.",
	});
	expect(document).toContain("Legacy briefing retained.");
	expect(document).toContain("Feature 7");
	expect(document).not.toContain("## Feature 0");
	expect(document.match(/<!-- ytimesy-knowledge:feature-0 -->/g)).toHaveLength(
		1,
	);
	expect(document).toContain("Corrected implementation location.");
});

it("requests duplicate consolidation without deleting or trusting any note", () => {
	const document = updateProjectKnowledge(updateProjectKnowledge("", branch), {
		...branch,
		key: "duplicate",
	});
	expect(projectMemoryMaintenance(document)).toMatchObject({
		recommended: true,
		duplicates: [["branch-selection", "duplicate"]],
	});
	expect(knowledgeForTask(document, "anything", false)).toContain(
		"Memory maintenance recommended",
	);
	expect(document).toContain("ytimesy-knowledge:duplicate");
});

it("gives children relevant entries without legacy briefing or unrelated context", () => {
	const document = updateProjectKnowledge(
		updateProjectKnowledge("Old sibling reply", branch),
		{
			...branch,
			key: "billing",
			title: "Billing",
			content: "Invoices",
			sources: ["billing.ts"],
		},
	);
	expect(knowledgeForTask(document, "Fix branch selection", true)).toContain(
		"repo/src/branch.ts",
	);
	expect(
		knowledgeForTask(document, "Fix branch selection", true),
	).not.toContain("Invoices");
	expect(
		knowledgeForTask(document, "Fix branch selection", true),
	).not.toContain("Old sibling reply");
	expect(knowledgeForTask(document, "Change avatar", true)).toContain(
		"[[memory/branch-selection]]",
	);
	expect(knowledgeForTask(document, "Change avatar", true)).not.toContain(
		"Invoices",
	);
	expect(knowledgeForTask(document, "Change avatar", false)).toContain(
		"[[memory/branch-selection]]",
	);
});

it("rejects overflow and reserved markers rather than silently truncating knowledge", () => {
	expect(() =>
		updateProjectKnowledge("x".repeat(PROJECT_KNOWLEDGE_LIMIT), branch),
	).toThrow("full");
	expect(() => updateProjectKnowledge("", { ...branch, key: ".*" })).toThrow(
		"key",
	);
	expect(() =>
		updateProjectKnowledge("", {
			...branch,
			content: "<!-- /ytimesy-knowledge -->",
		}),
	).toThrow("markers");
});

it("keeps prompt memory bounded while searching the complete larger store", () => {
	let document = "";
	for (let index = 0; index < 30; index++)
		document = updateProjectKnowledge(document, {
			...branch,
			key: `topic-${index}`,
			title: `Topic ${index}`,
			content: `Feature${index} ${"x".repeat(2000)}`,
		});
	expect(document.length).toBeGreaterThan(12000);
	expect(
		knowledgeForTask(document, "Feature29", false).length,
	).toBeLessThanOrEqual(PROJECT_KNOWLEDGE_CONTEXT_LIMIT);
	expect(searchProjectKnowledge(document, "Feature29")[0].key).toBe("topic-29");
	expect(searchProjectKnowledge(document, ".*")).toEqual([]);
});

it("gives the shell builder only trust rules, never tools it lacks", () => {
	for (const name of [
		"search_project_memory",
		"read_project_memory",
		"remember_project",
		"inspect_project_evidence",
		"search_tools",
	])
		expect(BUILDER_PROJECT_KNOWLEDGE_INSTRUCTIONS).not.toContain(name);
	expect(BUILDER_PROJECT_KNOWLEDGE_INSTRUCTIONS).toContain("untrusted");
});
