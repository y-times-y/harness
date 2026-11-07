import path from "node:path";
import { canonicalPath, isPathInside } from "./io.ts";
import type { LocalSession, Turn } from "./types.ts";

const DIGEST_HEADER = "[Summary of earlier context]";
const DIGEST_MAX_TASK_CHARS = 240;
const DIGEST_MAX_FILES = 12;
const REDACTED = "[REDACTED]";

function allToolCalls(session: Pick<LocalSession, "turns">) {
	return session.turns.flatMap((turn) => turn.toolCalls);
}

/** Shell commands that exited 0, first occurrence order, without duplicates. */
export function successfulCommands(
	session: Pick<LocalSession, "turns">,
): string[] {
	const commands: string[] = [];
	const seen = new Set<string>();
	for (const call of allToolCalls(session)) {
		if (call.kind !== "shell" || call.exitCode !== 0 || !call.command) continue;
		const command = call.command.trim();
		if (seen.has(command)) continue;
		seen.add(command);
		commands.push(command);
	}
	return commands;
}

export interface TouchedFiles {
	/** Existing files changed by edit tools, patches or shell commands. */
	edited: string[];
	/** Files created or overwritten by write tools (or patches that only add files). */
	written: string[];
	/** Files only read (never edited or written in the session). */
	read: string[];
}

/**
 * Files the session touched. Relative paths resolve against the session cwd; with
 * `root`, paths inside it are returned relative to it.
 */
export function touchedFiles(
	session: Pick<LocalSession, "turns" | "cwd">,
	options: { root?: string } = {},
): TouchedFiles {
	const root = options.root ? canonicalPath(options.root) : undefined;
	const sessionCwd = canonicalPath(session.cwd);
	const display = (file: string): string => {
		const absolute = path.isAbsolute(file)
			? file
			: path.resolve(sessionCwd, file);
		if (root && isPathInside(absolute, root))
			return path.relative(root, absolute) || ".";
		return absolute;
	};
	const edited: string[] = [];
	const written: string[] = [];
	const read: string[] = [];
	const add = (list: string[], file: string) => {
		const shown = display(file);
		if (!list.includes(shown)) list.push(shown);
	};
	for (const call of allToolCalls(session)) {
		if (call.kind === "write")
			for (const file of call.paths) add(written, file);
		if (call.kind === "edit") for (const file of call.paths) add(edited, file);
		if (call.kind === "read") for (const file of call.paths) add(read, file);
		for (const file of call.changedPaths)
			if (!written.includes(display(file))) add(edited, file);
	}
	return {
		edited,
		written,
		read: read.filter(
			(file) => !edited.includes(file) && !written.includes(file),
		),
	};
}

function replaceAll(text: string, secrets: string[]): string {
	let result = text;
	for (const secret of secrets)
		if (result.includes(secret)) result = result.split(secret).join(REDACTED);
	return result;
}

/** A copy of the session with every given value replaced by [REDACTED] in every string field. */
export function redact<T extends LocalSession>(
	session: T,
	values: readonly string[],
): T {
	const secrets = [...new Set(values.filter((value) => value.length > 0))].sort(
		(a, b) => b.length - a.length,
	);
	if (secrets.length === 0) return structuredClone(session);
	const visit = (node: unknown): unknown => {
		if (typeof node === "string") return replaceAll(node, secrets);
		if (Array.isArray(node)) return node.map(visit);
		if (node && typeof node === "object") {
			return Object.fromEntries(
				Object.entries(node).map(([key, child]) => [key, visit(child)]),
			);
		}
		return node;
	};
	return visit(session) as T;
}

export function turnChars(turn: Turn): number {
	let total = turn.text.length;
	for (const call of turn.toolCalls)
		total += call.input.length + (call.output?.length ?? 0);
	return total;
}

function truncateChars(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, Math.max(0, max))}…` : text;
}

/** Rule-based digest of turns removed by trimming; no model call. */
export function digestDroppedTurns(dropped: Turn[]): string | undefined {
	if (dropped.length === 0) return undefined;
	const task = dropped.find(
		(turn) => turn.role === "user" && !turn.synthetic,
	)?.text;
	const toolNames: string[] = [];
	const files: string[] = [];
	for (const call of dropped.flatMap((turn) => turn.toolCalls)) {
		if (!toolNames.includes(call.name)) toolNames.push(call.name);
		for (const file of [...call.paths, ...call.changedPaths])
			if (!files.includes(file)) files.push(file);
	}
	const lines = [
		DIGEST_HEADER,
		`This conversation continued from an earlier session; ${dropped.length} earlier turn(s) were trimmed to stay within the context budget.`,
	];
	if (task)
		lines.push(
			`Original task: "${truncateChars(task, DIGEST_MAX_TASK_CHARS)}"`,
		);
	if (toolNames.length > 0)
		lines.push(`Tools used earlier: ${toolNames.join(", ")}`);
	if (files.length > 0) {
		const shown = files.slice(0, DIGEST_MAX_FILES).join(", ");
		const more = files.length - DIGEST_MAX_FILES;
		lines.push(
			`Files touched earlier: ${shown}${more > 0 ? ` (+${more} more)` : ""}`,
		);
	}
	return lines.join("\n");
}

/**
 * Keeps the newest turns within `budgetChars`. If the source stored a compaction
 * summary, the newest one is kept first and turns before it are dropped (they are
 * what it summarizes). Turns dropped for the budget are replaced by a rule-based
 * digest. The newest turn is always kept, its text cut to fit if needed.
 */
export function trimToBudget(turns: Turn[], budgetChars: number): Turn[] {
	let compactionIndex = -1;
	turns.forEach((turn, index) => {
		if (turn.synthetic === "compaction-summary") compactionIndex = index;
	});
	const compaction =
		compactionIndex === -1
			? undefined
			: { ...(turns[compactionIndex] as Turn) };
	const rest = turns.slice(compactionIndex + 1);

	const newest = rest.at(-1);
	const newestNeeded = newest ? Math.min(turnChars(newest), budgetChars) : 0;
	if (compaction)
		compaction.text = truncateChars(
			compaction.text,
			Math.max(0, budgetChars - newestNeeded),
		);
	const restBudget = Math.max(
		0,
		budgetChars - (compaction ? turnChars(compaction) : 0),
	);

	let total = 0;
	let cutIndex = rest.length;
	for (let index = rest.length - 1; index >= 0; index--) {
		total += turnChars(rest[index] as Turn);
		if (total > restBudget) break;
		cutIndex = index;
	}
	if (cutIndex === rest.length && newest) {
		cutIndex = rest.length - 1;
		rest[cutIndex] = {
			...newest,
			text: truncateChars(newest.text, restBudget),
		};
	}
	if (cutIndex === 0 && !compaction) return rest;

	const dropped = rest.slice(0, cutIndex);
	const kept = rest.slice(cutIndex);
	const digest = digestDroppedTurns(dropped);
	const result: Turn[] = [];
	if (compaction) result.push(compaction);
	if (digest)
		result.push({
			role: "user",
			text: digest,
			toolCalls: [],
			synthetic: "trim-digest",
		});
	result.push(...kept);
	return result;
}
