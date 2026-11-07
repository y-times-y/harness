import type { ModelMessage } from "ai";
import type { AgentToolWorkspaceInput } from "./agent-tool-workspace";
import {
	inspectRepositoryGuidance,
	type RepositoryGuidance,
	RepositoryGuidanceUnavailable,
} from "./repository-guidance";

const HEADING = "# Repository instructions";
const INITIAL = `${HEADING}\n\nLoaded automatically from this checkout, like an AGENTS.md file. Follow them as the repository maintainers' instructions; the user's requests take precedence when they conflict.`;
const CHANGED = `${HEADING} changed\n\nThese sections changed in the checkout since they were provided earlier in this conversation and replace the earlier copies.`;
const RESTORED = `${HEADING} (restored after context compaction)\n\nReloaded from the current checkout; they still apply.`;

/** A linked document is inlined only when it is short; longer ones are listed. */
const INLINE_DOCUMENT_CHARACTERS = 8_000;
const INLINE_DOCUMENTS_TOTAL = 16_000;
const MANIFEST_PREVIEW_CHARACTERS = 8_000;

function documentSize(characters: number, nextStart: number | null) {
	const thousands = Math.max(1, Math.round(characters / 1000));
	return `${nextStart === null ? "about" : "over"} ${thousands}k characters`;
}

type Section = {
	text: string;
	/** Configuration previews change with the builder's own edits; they are restored, not re-announced. */
	announceChanges: boolean;
};

function truncated(path: string, nextStart: number | null) {
	return nextStart === null
		? ""
		: `\n[Shown up to character ${nextStart}; read the rest of ${path} with cat before relying on it.]`;
}

function instructionScope(path: string) {
	if (path.startsWith("../"))
		return "from a parent folder of this checkout; applies to the whole checkout";
	return path.includes("/")
		? `applies to files under ${path.slice(0, path.lastIndexOf("/"))}/`
		: "applies to the whole repository";
}

/** Render the scanned guidance as independent sections so a change can be re-sent alone. */
export function repositoryInstructionSections(
	guidance: RepositoryGuidance,
): Section[] {
	const sections: Section[] = guidance.instructions.map((entry) => ({
		text: `## ${entry.path} (${instructionScope(entry.path)})\n\n<INSTRUCTIONS>\n${entry.content ?? ""}\n</INSTRUCTIONS>${truncated(entry.path, entry.nextStart)}`,
		announceChanges: true,
	}));
	const nested = guidance.nestedInstructionFiles;
	sections.push({
		text:
			nested === null
				? "## Nested instruction files\n\nNested instruction files could not be listed. Check for AGENTS.md or CLAUDE.md in folders you work in."
				: nested.length
					? `## Nested instruction files\n\nThese folders have their own instructions, which apply to files under them and take precedence over the ones above. Before reading or changing files in one of these folders, read its file completely with cat:\n${nested.map((path) => `- ${path}`).join("\n")}${guidance.nestedInstructionFilesTruncated ? "\n[List truncated; check for AGENTS.md or CLAUDE.md in other folders you work in.]" : ""}`
					: "## Nested instruction files\n\nNo other folder in this repository has its own AGENTS.md or CLAUDE.md.",
		announceChanges: true,
	});
	const unreadable = guidance.unreadableFiles ?? [];
	if (unreadable.length)
		sections.push({
			text: `## Files this agent cannot read\n\nThis agent's user cannot read these files, so any instructions or configuration in them are not included above:\n${unreadable.map((path) => `- ${path}`).join("\n")}`,
			announceChanges: true,
		});
	if (guidance.skills.length)
		sections.push({
			text: `## Skills\n\nWhen the task matches a skill's description, read its SKILL.md completely with cat before acting:\n${guidance.skills
				.map((skill) =>
					"name" in skill
						? `- ${skill.name}: ${skill.description} (${skill.path})`
						: `- ${skill.path} (no name or description metadata)`,
				)
				.join(
					"\n",
				)}${guidance.skillLimitReached ? "\n[Only the first 100 skills are listed.]" : ""}`,
			announceChanges: true,
		});
	// Linked documents are often long plans or references the instructions ask
	// for only in some situations ("before architectural changes, read
	// PLAN.md"). Inline the short ones; list the rest for the builder to cat.
	// Every request carries this message, so a 100k-character plan costs
	// tens of thousands of tokens per step whether or not it applies.
	let inlineBudget = INLINE_DOCUMENTS_TOTAL;
	const listed: string[] = [];
	for (const document of guidance.referencedDocuments) {
		const content = document.content ?? "";
		if (
			document.content !== undefined &&
			document.nextStart === null &&
			content.length <= Math.min(INLINE_DOCUMENT_CHARACTERS, inlineBudget)
		) {
			inlineBudget -= content.length;
			sections.push({
				text: `## ${document.path} (linked from ${document.referencedBy})\n\n<DOCUMENT>\n${content}\n</DOCUMENT>`,
				announceChanges: true,
			});
			continue;
		}
		listed.push(
			`- ${document.path} (linked from ${document.referencedBy}${document.content === undefined ? "" : `; ${documentSize(content.length, document.nextStart)}`})`,
		);
	}
	if (listed.length)
		sections.push({
			text: `## Linked documents not included\n\nThe instructions above link these documents. Read one completely with cat when the instructions say it applies to your task:\n${listed.join("\n")}`,
			announceChanges: true,
		});
	if (guidance.documentLimitReached)
		sections.push({
			text: "## Further linked documents\n\nThe instructions link more Markdown documents than were included; read any that apply with cat.",
			announceChanges: true,
		});
	// The manifest names the scripts and dependencies; other build/lint
	// configuration is named only, for the builder to read when relevant.
	const otherConfiguration: string[] = [];
	for (const file of guidance.configuration) {
		if (file.path !== "package.json") {
			otherConfiguration.push(file.path);
			continue;
		}
		const content = file.content ?? "";
		const shown = content.slice(0, MANIFEST_PREVIEW_CHARACTERS);
		sections.push({
			text: `## Project configuration: ${file.path} (preview)\n\n\`\`\`\n${shown}\n\`\`\`${truncated(file.path, shown.length < content.length ? shown.length : file.nextStart)}`,
			announceChanges: false,
		});
	}
	if (otherConfiguration.length)
		sections.push({
			text: `## Other project configuration\n\nAlso at the repository root: ${otherConfiguration.join(", ")}. Read them with cat when relevant.`,
			announceChanges: false,
		});
	return sections;
}

function guidanceMessages(messages: readonly ModelMessage[]) {
	return messages.flatMap((message) =>
		message.role === "user" &&
		typeof message.content === "string" &&
		message.content.startsWith(HEADING)
			? [message.content]
			: [],
	);
}

/** Whether repository instructions were ever delivered in this history. */
export function hasRepositoryInstructions(messages: readonly ModelMessage[]) {
	return guidanceMessages(messages).length > 0;
}

/** Before any model step: only the runtime's own preflight reads precede the task. */
function freshHistory(messages: readonly ModelMessage[]) {
	return messages.every(
		(message) =>
			message.role !== "assistant" ||
			(Array.isArray(message.content) &&
				message.content.every(
					(part) =>
						part.type === "tool-call" &&
						part.toolCallId.startsWith("call_prefetch_"),
				)),
	);
}

/**
 * Append-only: a fresh history gets the instructions ahead of the task (a
 * stable, cacheable prefix); otherwise they follow the existing messages,
 * which are never rewritten. Only sections absent from the history are sent.
 */
export function withRepositoryInstructions(
	messages: ModelMessage[],
	sections: readonly Section[],
	reason: "turn-start" | "compaction",
): ModelMessage[] {
	const earlier = guidanceMessages(messages);
	const missing = sections.filter(
		(section) =>
			!earlier.some((content) => content.includes(section.text)) &&
			(!earlier.length || reason === "compaction" || section.announceChanges),
	);
	if (!missing.length) return messages;
	const heading = !earlier.length
		? reason === "compaction"
			? RESTORED
			: INITIAL
		: reason === "compaction"
			? RESTORED
			: CHANGED;
	const message: ModelMessage = {
		role: "user",
		content: [heading, ...missing.map((section) => section.text)].join("\n\n"),
	};
	if (!earlier.length && reason === "turn-start" && freshHistory(messages))
		return [message, ...messages];
	return [...messages, message];
}

/**
 * Scan the checkout (root plus Git ancestors of a subdirectory checkout) and
 * render it. A scan that cannot run is a workspace condition, not a reason to
 * fail the turn (or to report it as a model failure): the agent proceeds
 * without the automatic copy and is told to read the files itself.
 */
export async function readRepositoryInstructions(
	workspace: AgentToolWorkspaceInput,
): Promise<Section[]> {
	let guidance: RepositoryGuidance;
	try {
		guidance = await inspectRepositoryGuidance(workspace, {
			scope: ".",
			gitAncestors: true,
		});
	} catch (error) {
		if (!(error instanceof RepositoryGuidanceUnavailable)) throw error;
		console.warn("Repository instructions were not loaded.", error.reason);
		return [
			{
				text: "## Repository instructions unavailable\n\nThey could not be loaded automatically from this checkout. Before relying on repository conventions, read AGENTS.md and CLAUDE.md at the repository root with cat if they exist.",
				announceChanges: true,
			},
		];
	}
	return repositoryInstructionSections(guidance);
}
