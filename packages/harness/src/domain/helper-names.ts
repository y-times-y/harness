import {
	isSubagentRole,
	type SubagentBudget,
	type SubagentRole,
} from "./subagent";

/**
 * How the chat shows its agents, everywhere: the agents list, the start
 * lines and finish cards, the helper view, and the agent tool's result and
 * report header the lead reads. The root agent is "Main"; a helper goes by a
 * short name, its kind and its number among the chat's helpers of that kind
 * in start order ("build-1", "research-2"), with its task as the text
 * beside it. Each kind has an icon; each helper has its own colour, the next
 * of HELPER_COLORS in start order. Internal role ids are unchanged.
 */

export const MAIN_NAME = "Main";

export type HelperKind = "sidekick" | SubagentRole;
export type AgentKind = "main" | HelperKind | "background";

/** The kind tag after a helper's name; Main has none. */
export const KIND_TAGS: Record<AgentKind, string | null> = {
	main: null,
	sidekick: "Build",
	writer: "Build",
	researcher: "Research",
	reviewer: "Review",
	checker: "Verify",
	background: "Background",
};

/** Lucide icon per kind (drawn in agent-icon.tsx). */
export type AgentIcon =
	| "dot"
	| "hammer"
	| "search"
	| "eye"
	| "circle-check"
	| "terminal";
export const KIND_ICONS: Record<AgentKind, AgentIcon> = {
	main: "dot",
	sidekick: "hammer",
	writer: "hammer",
	researcher: "search",
	reviewer: "eye",
	checker: "circle-check",
	background: "terminal",
};

/**
 * Main's and background commands' colours, as CSS custom properties on :root
 * (styles.css). Helpers take HELPER_COLORS instead. Colour goes on icons
 * only; text stays neutral.
 */
export const AGENT_COLOR_TOKENS = {
	main: "--agent-main",
	background: "--agent-background",
} as const;

/** A colour value for CSS: Main's or background commands' token. */
export function agentColor(kind: keyof typeof AGENT_COLOR_TOKENS) {
	return `var(${AGENT_COLOR_TOKENS[kind]})`;
}

/**
 * Each helper's icon colour, in the order the chat started them: red, green,
 * blue, orange, gold, at an even brightness on the dark background. Helpers
 * six to ten take paler versions of the same five, so no two look alike;
 * after ten the ten repeat.
 */
export const HELPER_COLORS = [
	"#FF8F96",
	"#9CD242",
	"#83C1FF",
	"#FF9D62",
	"#E0BA31",
	"#FFC1C5",
	"#C9E697",
	"#BBDDFF",
	"#FFC9A9",
	"#EED98E",
] as const;

/** The colour of the chat's nth helper (0-based, in start order). */
export function helperColor(index: number) {
	return HELPER_COLORS[
		((Math.trunc(index) % HELPER_COLORS.length) + HELPER_COLORS.length) %
			HELPER_COLORS.length
	] as string;
}

/** "build-1": a helper's kind, lowercased, and its number among that kind. */
export function helperShortName(kind: HelperKind, number: number) {
	return `${(KIND_TAGS[kind] as string).toLowerCase()}-${number}`;
}

/** Lead mode fusion's sidekick is a writer whose budget carries its sidekick state. */
export function helperKind(helper: {
	readonly subagent?: {
		readonly role: SubagentRole;
		readonly budget: SubagentBudget | null;
	};
}): HelperKind {
	if (helper.subagent?.budget?.sidekick) return "sidekick";
	return helper.subagent?.role ?? "writer";
}

export function helperKindOf(
	role: SubagentRole,
	budget: SubagentBudget | null | undefined,
): HelperKind {
	return budget?.sidekick ? "sidekick" : role;
}

const NAME_MAX = 36;

/** "package-research" or "build_helper": a slug, not a task. */
const SLUG = /^[a-z0-9]+(?:[-_][a-z0-9]+)+$/i;

/** A helper's name: its task title, cut cleanly at a word; a slug reads as words. */
export function helperName(title: string) {
	let words = title.replace(/\s+/g, " ").trim();
	if (SLUG.test(words)) {
		const spaced = words.replace(/[-_]+/g, " ").toLowerCase();
		words = spaced.charAt(0).toUpperCase() + spaced.slice(1);
	}
	if (!words) return "Untitled task";
	if (words.length <= NAME_MAX) return words;
	const cut = words.slice(0, NAME_MAX - 1);
	const space = cut.lastIndexOf(" ");
	return `${(space > 12 ? cut.slice(0, space) : cut).replace(/[\s,.;:-]+$/, "")}…`;
}

/** How the lead names a helper to the user: build-1 ("Fix pricing rounding"). */
export function helperReference(shortName: string, title: string) {
	return `${shortName} ("${helperName(title)}")`;
}

/**
 * An agent call's helper as the timeline shows it: its task, with its kind
 * tag ("Fix pricing rounding" · Build), never its role word. Null tag for an
 * unknown role.
 */
export function helperCallLabel(call: {
	readonly title?: string;
	readonly role?: string;
	readonly sidekick?: boolean;
}): { readonly name: string; readonly tag: string | null } {
	const kind: HelperKind | null = call.sidekick
		? "sidekick"
		: isSubagentRole(call.role)
			? call.role
			: null;
	return {
		name: helperName(call.title ?? ""),
		tag: kind ? KIND_TAGS[kind] : null,
	};
}

export type HelperIdentity = {
	/** Its short name: "build-1". */
	readonly name: string;
	/** Its task, cut cleanly (helperName). */
	readonly task: string;
	readonly kind: HelperKind;
	readonly icon: AgentIcon;
	/** Its CSS colour (helperColor). */
	readonly color: string;
};

/**
 * Every helper of one chat (any depth), in start order: short name, task,
 * icon and colour. Numbers and colours follow start order, so a helper keeps
 * its own as others start and finish.
 */
export function helperIdentitiesOf(
	helpers: readonly {
		readonly id: string;
		readonly createdAt: string;
		readonly kind: HelperKind;
		readonly title: string;
	}[],
) {
	const ordered = [...helpers].sort(
		(left, right) =>
			left.createdAt.localeCompare(right.createdAt) ||
			left.id.localeCompare(right.id),
	);
	// Numbered per tag: a sidekick and a writer are both "build".
	const seen = new Map<string, number>();
	const identities = new Map<string, HelperIdentity>();
	ordered.forEach((helper, index) => {
		const tag = KIND_TAGS[helper.kind] as string;
		const number = (seen.get(tag) ?? 0) + 1;
		seen.set(tag, number);
		identities.set(helper.id, {
			name: helperShortName(helper.kind, number),
			task: helperName(helper.title),
			kind: helper.kind,
			icon: KIND_ICONS[helper.kind],
			color: helperColor(index),
		});
	});
	return identities;
}
