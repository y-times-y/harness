/**
 * The section ytimesy keeps at the end of the pull requests it opens: how to
 * ask for a change, and one "Generated with ytimesy" line. It is replaced, never repeated, on updates.
 */
export const FOOTER_START = "<!-- ytimesy-fix:start -->";
export const FOOTER_END = "<!-- ytimesy-fix:end -->";

export type PullRequestFooter = {
	/** The "Fix with ytimesy" page for this pull request. */
	readonly fixUrl?: string | null;
	/** The App's handle, like `@ytimesy-agent`; shown only when a comment can wake the chat. */
	readonly mention?: string | null;
	/** The chat that made the change. */
	readonly chatUrl?: string | null;
};

export function pullRequestFooterSection(footer: PullRequestFooter) {
	const ask = [
		footer.fixUrl ? `[Fix with ytimesy](${footer.fixUrl})` : null,
		footer.mention
			? `${footer.fixUrl ? "or comment" : "Comment"} \`${footer.mention} <what to change>\` on this pull request.`
			: null,
	]
		.filter(Boolean)
		.join(" · ");
	const signature = footer.chatUrl
		? `Generated with [ytimesy](${footer.chatUrl})`
		: "Generated with ytimesy";
	return [FOOTER_START, "---", ...(ask ? [ask, ""] : []), signature, FOOTER_END]
		.join("\n")
		.trim();
}

/** The description without the footer section. */
export function withoutPullRequestFooter(body: string) {
	const start = body.indexOf(FOOTER_START);
	const end = body.indexOf(FOOTER_END, start);
	if (start === -1 || end === -1) return body;
	return `${body.slice(0, start).trimEnd()}\n\n${body.slice(end + FOOTER_END.length).trimStart()}`.trim();
}

/** The description with exactly one footer section, at its end. */
export function withPullRequestFooter(body: string, footer: PullRequestFooter) {
	const text = withoutPullRequestFooter(body).trim();
	const section = pullRequestFooterSection(footer);
	return text ? `${text}\n\n${section}` : section;
}

/** Puts a section just before the footer, or at the end when there is none. */
export function insertBeforePullRequestFooter(body: string, section: string) {
	const start = body.indexOf(FOOTER_START);
	if (start === -1)
		return body.trim() ? `${body.trimEnd()}\n\n${section}` : section;
	const before = body.slice(0, start).trimEnd();
	return `${before ? `${before}\n\n` : ""}${section}\n\n${body.slice(start)}`;
}
