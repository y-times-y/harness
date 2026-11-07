import type { HandoffDocument } from "./local-import";

/**
 * The handoff chat's first item, at a glance: what the local session set out
 * to do, where it stopped and what comes next, derived from the uploaded
 * handoff without a model call. Every line is one short sentence; the
 * details (files, commands, transcript) sit behind a fold.
 */
export type HandoffSummary = {
	/**
	 * The user's request: the first substantive one sent (greetings and
	 * approvals skipped), or the title when earlier turns were trimmed or none is.
	 */
	readonly goal: string | null;
	/** The gist of the agent's last message. */
	readonly stopped: string | null;
	/** An unanswered last request, or the "next steps" the agent named. */
	readonly next: string | null;
	/** The local branch the session worked on (the card shows it as "from <branch>"). */
	readonly localBranch: string | null;
	/** Edited and created files, relative to the repository (at most SUMMARY_FILES). */
	readonly edited: readonly string[];
	readonly editedCount: number;
	/** Commands that succeeded (at most SUMMARY_COMMANDS). */
	readonly commands: readonly string[];
	/** The full transcript on the chat's machine. */
	readonly transcript: string;
};

/** Paths the CLI pushed or skipped, as sent to finish (paths only, bounded). */
export type HandoffFiles = {
	readonly pushed: readonly string[];
	readonly pushedCount: number;
	readonly skipped: readonly string[];
	readonly skippedCount: number;
};

export const SUMMARY_FILES = 12;
export const SUMMARY_COMMANDS = 8;
const GOAL_CHARS = 110;
const STOPPED_CHARS = 130;
const NEXT_CHARS = 110;

/** Wrapper tags agents put in user turns (hooks, slash commands, reminders): never the request. */
const NOISE_BLOCK =
	/<(system-reminder|command-[\w-]+|local-command-[\w-]+|user-prompt-submit-hook|ide_[\w-]+|environment_context|user_instructions)\b[^>]*>[\s\S]*?<\/\1>/gi;

/** Markdown and markup as plain, single-line text. */
export function plainSummaryText(text: string) {
	return text
		.replace(/```[\s\S]*?(?:```|$)/g, " ")
		.replace(NOISE_BLOCK, " ")
		.replace(/<\/?[A-Za-z][\w:-]*(?:\s[^<>]*)?\/?>/g, " ")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/`([^`\n]+)`/g, "$1")
		.replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s?)/gm, "")
		.replace(/(\*\*|__)(.+?)\1/g, "$2")
		.replace(/\s+/g, " ")
		.trim();
}

/** At most `limit` characters, cut at a word with an ellipsis. */
export function shortened(text: string, limit: number) {
	if (text.length <= limit) return text;
	const cut = text.slice(0, limit - 1);
	const space = cut.lastIndexOf(" ");
	return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.–—-]+$/, "")}…`;
}

/** The first sentence (or two, when the first is very short), shortened. */
function gist(text: string, limit: number) {
	let result = text;
	for (const end of text.matchAll(/[.!?]+(?=\s|$)/g)) {
		result = text.slice(0, end.index + end[0].length);
		if (result.length >= 24) break;
		result = text;
	}
	return shortened(result.trim(), limit);
}

const NOT_A_REQUEST = /^\[Request interrupted|^Caveat: The messages below/i;

type Turn = HandoffDocument["turns"][number];

function spoken(turn: Turn) {
	if (turn.synthetic) return "";
	const text = plainSummaryText(turn.text);
	return NOT_A_REQUEST.test(text) ? "" : text;
}

const NEXT_HEADING =
	/^\s*(?:#{1,6}\s*)?(?:[-*+]\s*)?(?:\*\*|__)?(next steps?|next up|next|remaining( work)?|still (?:to do|open)|to ?do|follow-?ups?)(?:\*\*|__)?\s*[:—-]?\s*(?:\*\*|__)?\s*(.*)$/i;

/** The first item under a "Next steps" line of the agent's message, if any. */
function namedNextStep(text: string) {
	const lines = text.replace(/```[\s\S]*?```/g, "").split("\n");
	for (const [index, line] of lines.entries()) {
		const match = NEXT_HEADING.exec(line);
		if (!match) continue;
		const rest = plainSummaryText(match[3] ?? "");
		if (rest.length > 3) return rest;
		const following = lines
			.slice(index + 1)
			.map((candidate) => plainSummaryText(candidate))
			.find(Boolean);
		if (following) return following;
	}
	return null;
}

const ACKNOWLEDGEMENT_WORDS = new Set(
	(
		"yes yeah yea yep yup y ya ok okay okey k kk sure fine great good nice cool perfect " +
		"awesome excellent thanks thank you thx ty please pls plz go ahead proceed continue " +
		"carry on keep going do it approve approved approval accept accepted i we agree agreed " +
		"lgtm sounds looks good right correct alright alrighty hi hello hey yo morning then " +
		"and so now that this it check confirm confirmed done let's lets got sgtm works " +
		"makes sense true exactly indeed absolutely definitely"
	).split(" "),
);

/**
 * A greeting, approval or short acknowledgement ("yes", "ok go ahead",
 * "check then please i approve"): every word is one of those, and there are
 * only a few. Anything naming a thing to do ("yes, fix the tests") is a request.
 */
export function isAcknowledgement(text: string) {
	const words = text
		.toLowerCase()
		.replace(/[^a-z' ]+/g, " ")
		.split(/\s+/)
		.filter(Boolean);
	if (!words.length) return true;
	return (
		words.length <= 12 && words.every((word) => ACKNOWLEDGEMENT_WORDS.has(word))
	);
}

/** A request worth naming as the goal: spoken, and not an acknowledgement. */
function substantive(turn: Turn) {
	const text = spoken(turn);
	return text && !isAcknowledgement(text) ? text : "";
}

/**
 * A file the session touched, relative to its repository: the session's own
 * folder is stripped, and so is a worktree's (Codex keeps them at
 * ~/.codex/worktrees/<name>/<repo>/, Claude Code at .claude/worktrees/<name>/).
 * Relative paths stay; other absolute paths keep their home as ~.
 */
export function repositoryRelativePath(cwd: string, file: string) {
	const root = cwd.replace(/\/+$/, "");
	let path = file.replace(/^\.\//, "");
	if (root && path.startsWith(`${root}/`)) path = path.slice(root.length + 1);
	const worktree =
		/(?:^|\/)\.codex\/worktrees\/[^/]+\/[^/]+\/(.+)$/.exec(path) ??
		/(?:^|\/)\.claude\/worktrees\/[^/]+\/(.+)$/.exec(path);
	if (worktree) return worktree[1] as string;
	return path.replace(/^\/(?:Users|home)\/[^/]+\//, "~/");
}

/** The summary card's content, from the handoff the CLI uploaded. */
export function handoffSummary(
	handoff: HandoffDocument,
	options: { readonly transcript: string },
): HandoffSummary {
	const turns = handoff.turns;
	const title = handoff.title ? plainSummaryText(handoff.title) : "";
	const firstUser = turns.find(
		(turn) => turn.role === "user" && substantive(turn),
	);
	// Turns before the first sent one were trimmed: the title names the session better.
	const trimmed = turns[0]?.synthetic !== undefined;
	const goalText =
		(trimmed && title) || (firstUser ? substantive(firstUser) : "") || title;
	const spokenTurns = turns.filter((turn) => spoken(turn));
	const lastAgent = [...spokenTurns]
		.reverse()
		.find((turn) => turn.role === "assistant");
	const last = spokenTurns.at(-1);
	const unanswered =
		last?.role === "user" && last !== firstUser
			? substantive(last) || null
			: null;
	const nextText =
		unanswered ?? (lastAgent ? namedNextStep(lastAgent.text) : null);
	const edited = [
		...new Set(
			[...handoff.files.edited, ...handoff.files.written].map((file) =>
				repositoryRelativePath(handoff.cwd, file),
			),
		),
	];
	return {
		goal: goalText ? gist(goalText, GOAL_CHARS) : null,
		stopped: lastAgent ? gist(spoken(lastAgent), STOPPED_CHARS) : null,
		next: nextText ? gist(nextText, NEXT_CHARS) : null,
		localBranch: handoff.gitBranch ?? null,
		edited: edited.slice(0, SUMMARY_FILES),
		editedCount: edited.length,
		commands: [...new Set(handoff.successfulCommands)]
			.slice(0, SUMMARY_COMMANDS)
			.map((command) => shortened(command.replace(/\s+/g, " ").trim(), 120)),
		transcript: options.transcript,
	};
}
