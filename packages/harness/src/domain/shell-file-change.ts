import { countFileChangeLines } from "./diff-stats";
import type { FileChangeEntry } from "./session-item";
import { unwrapShellCommand } from "./visible-shell-command";

const CAT_WRITE =
	/(?:cat|tee)\s+(>>?)\s+(['"]?)([^'"\n]+?)\2\s+<<(['"]?)(\w+)\4\n([\s\S]*?)\n\5\b/g;
const TEE_WRITE =
	/tee\s+(['"]?)([^'"<\n]+?)\1\s+<<(['"]?)(\w+)\3\n([\s\S]*?)\n\4\b/g;
const APPLY_PATCH = /apply_patch\s+<<(['"]?)(\w+)\1\n([\s\S]*?)\n\2\b/g;

export function fileChangesFromShellCommand(
	command: string,
): FileChangeEntry[] {
	const source = unwrapShellCommand(command);
	return [
		...heredocWrites(source, CAT_WRITE, catWrite),
		...heredocWrites(source, TEE_WRITE, teeWrite),
		...applyPatchWrites(source),
	];
}

export function remainingShellCommandAfterWrites(
	command: string,
	writes: readonly FileChangeEntry[],
): string | null {
	if (writes.length === 0) return unwrapShellCommand(command) || null;
	const rest = unwrapShellCommand(command)
		.replace(CAT_WRITE, "\n")
		.replace(TEE_WRITE, "\n")
		.replace(APPLY_PATCH, "\n");
	const parts = rest
		.split(/\s*(?:&&|;)\s*/)
		.map((part) => part.trim())
		.filter(Boolean)
		.filter((part) => !mkdirOnlyCreatesWriteParents(part, writes));
	return parts.length > 0 ? parts.join(" && ") : null;
}

function heredocWrites(
	source: string,
	pattern: RegExp,
	toChange: (match: RegExpExecArray) => FileChangeEntry | null,
): FileChangeEntry[] {
	const changes: FileChangeEntry[] = [];
	pattern.lastIndex = 0;
	let match = pattern.exec(source);
	while (match) {
		const change = toChange(match);
		if (change) changes.push(change);
		match = pattern.exec(source);
	}
	return changes;
}

function catWrite(match: RegExpExecArray): FileChangeEntry | null {
	const redirect = match[1];
	const path = unquote(match[3] ?? "");
	const body = match[6] ?? "";
	if (!path) return null;
	return fileWrite(path, redirect === ">>" ? "update" : "add", body);
}

function teeWrite(match: RegExpExecArray): FileChangeEntry | null {
	const path = unquote(match[2] ?? "");
	const body = match[5] ?? "";
	if (!path) return null;
	return fileWrite(path, "add", body);
}

function applyPatchWrites(source: string): FileChangeEntry[] {
	const changes: FileChangeEntry[] = [];
	APPLY_PATCH.lastIndex = 0;
	let match = APPLY_PATCH.exec(source);
	while (match) {
		changes.push(...fileChangesFromApplyPatch(match[3] ?? ""));
		match = APPLY_PATCH.exec(source);
	}
	return changes;
}

function fileChangesFromApplyPatch(body: string): FileChangeEntry[] {
	const changes: FileChangeEntry[] = [];
	const blocks = body.split("*** End Patch");
	for (const block of blocks) {
		const add = block.match(/\*\*\* Add File:\s+(\S+)/);
		if (add?.[1]) {
			const preview = addedFilePreview(block);
			changes.push(fileWrite(add[1], "add", preview));
			continue;
		}
		const update = block.match(/\*\*\* Update File:\s+(\S+)/);
		if (update?.[1]) {
			const preview = block.slice(block.indexOf(update[0]) + update[0].length);
			const counted = countFileChangeLines("update", preview);
			changes.push({
				path: update[1],
				change: "update",
				additions: counted.additions,
				deletions: counted.deletions,
				preview: preview.trim() || null,
			});
			continue;
		}
		const deleted = block.match(/\*\*\* Delete File:\s+(\S+)/);
		if (deleted?.[1]) {
			changes.push({
				path: deleted[1],
				change: "delete",
				additions: 0,
				deletions: 0,
				preview: null,
			});
		}
	}
	return changes;
}

function addedFilePreview(block: string): string {
	const lines = block.split("\n");
	const start = lines.findIndex((line) => line.startsWith("*** Add File:"));
	return lines
		.slice(start + 1)
		.filter((line) => !line.startsWith("***"))
		.map((line) => (line.startsWith("+") ? line.slice(1) : line))
		.join("\n")
		.replace(/^\n+|\n+$/g, "");
}

function fileWrite(
	path: string,
	change: FileChangeEntry["change"],
	body: string,
): FileChangeEntry {
	const preview = body.replace(/\n$/, "");
	const counted = countFileChangeLines(change, preview);
	return {
		path,
		change,
		additions: counted.additions,
		deletions: counted.deletions,
		preview: preview || null,
	};
}

function mkdirOnlyCreatesWriteParents(
	part: string,
	writes: readonly FileChangeEntry[],
): boolean {
	const mkdir = part.match(/^mkdir(?:\s+-p)?\s+(\S+)$/);
	if (!mkdir?.[1]) return false;
	const dir = unquote(mkdir[1]).replace(/\/$/, "");
	return writes.some((write) => {
		const parent = write.path.replace(/\/[^/]+$/, "");
		return parent === dir || write.path.startsWith(`${dir}/`);
	});
}

function unquote(value: string): string {
	return value.replace(/^['"]|['"]$/g, "");
}
