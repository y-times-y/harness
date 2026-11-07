import { isInternalChildTaskMessage } from "./child-task-activity";
import type { SessionItem } from "./session-item";

/**
 * Rigor (harness variant rigor=on): the builder's block on ambiguity,
 * finishing and running the deliverable as an outside user would, the root
 * builder's up-front requirements list, and the review loop's test for a
 * final answer that admits unverified work. The checker's side is in
 * checker-brief.ts.
 */

/** The builder's rigor block (root builder and writers; readers never get it). */
export const RIGOR_BUILDER_INSTRUCTIONS = [
	"Rigor:",
	"- Ambiguous wording: list the plausible readings before you choose. Prefer the convention of the library, ecosystem or standard involved, even over a stricter or more literal reading; take the strictest reading only when no convention applies. Keep a safety margin on numeric thresholds instead of landing on the edge. Name each choice in your final answer.",
	'- An explicit enumerated list or precedence order beats general guidance such as "minimal" or "avoid redundancy": an item the list does not name for a slot cannot fill it, even if it carries the same facts.',
	"- Before finishing, run the deliverable as an outside user would: a fresh shell and process, a clean directory with only the files the request names, no dependencies or data files the request does not provide or declare, and results read back with standard clients and tools, not helpers you wrote.",
	"- Reported symptoms or bugs: treat each one the request reports as an acceptance test. Reproduce it using only the existing calls a normal caller would make, and see it fail before your fix and pass after. A fix that needs callers to adopt a new method, protocol or extra calls does not fix that symptom, and a docstring or comment describing the buggy behaviour does not make it correct. Never declare a reported symptom unresolvable while time remains.",
	"- Do not finish with time left while something is unverified or a known risk is open: verify or fix it first. Report as unverified only what cannot be checked here.",
].join("\n");

/** Most lines a builder's requirements list keeps. */
export const MAX_BUILDER_REQUIREMENTS = 25;

/**
 * The root builder's requirements list (not writers: they work from a brief).
 * It is written in the builder's own message between tag lines, never to a
 * file, so it cannot reach a commit; the review loop takes the latest block
 * of the turn from the transcript.
 */
export const RIGOR_REQUIREMENTS_INSTRUCTIONS = `- Requirements: before you start, write the request's requirements in your message between a <requirements> line and a </requirements> line, never in a file: one line each, at most ${MAX_BUILDER_REQUIREMENTS}, from the request and the files it points to (names, paths, formats, values, units, limits, invocation, side effects). Mark an ambiguous item with the reading you chose. Before finishing, re-check every item against the actual result; fix an unmet one or report it in your final answer.`;

/** Lead mode fusion: when the lead writes the list and what the sidekick gets. */
export const RIGOR_LEAD_REQUIREMENTS =
	"- As Main, write the list right after the exploration report, before your first brief, and put the items a brief covers into that brief.";

const REQUIREMENTS_BLOCK = /<requirements>([\s\S]*?)<\/requirements>/gi;

/** The last requirements block in a text, one item per line (null when none). */
export function requirementsFromText(text: string): string[] | null {
	const block = [...text.matchAll(REQUIREMENTS_BLOCK)].at(-1)?.[1];
	if (block === undefined) return null;
	return block
		.split("\n")
		.map((line) => line.replace(/^\s*(?:[-*\u2022]|\d+[.)])?\s*/, "").trim())
		.filter(Boolean)
		.slice(0, MAX_BUILDER_REQUIREMENTS)
		.map((line) => (line.length > 300 ? `${line.slice(0, 297)}...` : line));
}

/** A message as the chat shows it: its prose, and each requirements block as a list. */
export type RequirementsSegment =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "requirements"; readonly items: readonly string[] };

/**
 * Splits a builder's message around its <requirements> blocks, so the chat
 * renders each as a list instead of raw tags. A block still streaming (no
 * closing line yet) is a list of the lines so far.
 */
export function requirementsSegments(text: string): RequirementsSegment[] {
	const segments: RequirementsSegment[] = [];
	const pattern = /<requirements>([\s\S]*?)(?:<\/requirements>|$(?![\s\S]))/gi;
	let last = 0;
	for (const match of text.matchAll(pattern)) {
		const before = text.slice(last, match.index);
		if (before.trim()) segments.push({ kind: "text", text: before });
		const items = requirementsFromText(
			`<requirements>${match[1]}</requirements>`,
		);
		segments.push({ kind: "requirements", items: items ?? [] });
		last = (match.index ?? 0) + match[0].length;
	}
	const rest = text.slice(last);
	if (rest.trim() || segments.length === 0)
		segments.push({ kind: "text", text: rest });
	return segments;
}

/**
 * The builder's latest requirements list in this turn: its messages since
 * the person's latest request (child-event messages do not start a turn).
 */
export function builderRequirements(
	items: readonly SessionItem[],
): string[] | null {
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (item.kind === "userMessage" && !isInternalChildTaskMessage(item.text))
			return null;
		if (item.kind !== "agentMessage") continue;
		const list = requirementsFromText(item.text);
		if (list?.length) return list;
	}
	return null;
}

/** Phrases that admit work was not verified or still fails. */
const ADMITS =
	/\b(unverified|not (?:been )?(?:verified|tested|confirmed|checked|run)|(?:could|did|was) ?n[o']t (?:verify|test|confirm|check|run)|unable to (?:verify|test|confirm|check|run)|untested|still (?:fails|failing|broken|open)|remaining risk|known risk|not yet (?:verified|tested|fixed))\b/i;

/** A line that says nothing is left unverified ("Unverified: none."). */
const NOTHING_LEFT =
	/^\W*(?:unverified|untested|remaining risks?|known risks?)\W*(?:none|nothing|n\/a)\b|\b(?:nothing|none|no part) (?:is |was |remains )?(?:left )?(?:unverified|untested)\b/i;

/**
 * The lines of a final answer that admit unverified or failing work (at most
 * three, each clipped); empty when it admits none.
 */
export function admittedUnverified(answer: string): string[] {
	return answer
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && ADMITS.test(line) && !NOTHING_LEFT.test(line))
		.slice(0, 3)
		.map((line) => (line.length > 300 ? `${line.slice(0, 297)}...` : line));
}

/** Share of the review loop's time that must be left for an admission to be sent back. */
export const UNVERIFIED_SEND_BACK_TIME_LEFT = 0.5;

/**
 * An unattended run (an unattended job): nobody answers a question
 * or approves a plan before the work is checked. Given to the root builder.
 */
export const UNATTENDED_RUN_INSTRUCTIONS =
	"Unattended run: nobody will answer a question or approve a plan before this work is graded. Never stop on an apparent contradiction or a missing input: ship the best-supported deliverable at the paths the request names and state the assumption in your final answer. A problem the request reports (a symptom, error or wrong result) is never resolved by calling the current behavior intended: reproduce it, then change the behavior so it no longer happens; an assumption may settle how to fix it, never whether to.";

/** Phrases that ask the user to act, or admit the deliverable is missing or unfinished. */
const UNFINISHED =
	/\b(please (?:provide|confirm|clarify|advise|let me know)|(?:could|can|would) you (?:provide|confirm|clarify|share|send|check)|let me know (?:if|whether|which|how)|before I (?:can )?(?:proceed|continue)|(?:cannot|can't|could not|couldn't|unable to) (?:proceed|continue|complete|finish|produce|generate)|(?:was|were|is|are|has been|have been) not (?:yet )?(?:created|written|produced|generated|delivered)|did ?n[o']t (?:create|write|produce|generate)|contradict(?:s|ory|ion|ions)?|inconsistent (?:inputs?|data|requirements?))\b/i;

/** A line that rules the above out ("no contradictions found"). */
const NOTHING_UNFINISHED =
	/\bno (?:contradictions?|inconsistenc(?:y|ies))\b|\bnothing (?:is )?(?:missing|left)\b/i;

/**
 * Unattended runs: the lines of a final answer that ask the user to resolve
 * something or admit a missing or unfinished deliverable (at most three,
 * each clipped); empty when it has none.
 */
export function admittedUnfinished(answer: string): string[] {
	return answer
		.split("\n")
		.map((line) => line.trim())
		.filter(
			(line) => line && UNFINISHED.test(line) && !NOTHING_UNFINISHED.test(line),
		)
		.slice(0, 3)
		.map((line) => (line.length > 300 ? `${line.slice(0, 297)}...` : line));
}
