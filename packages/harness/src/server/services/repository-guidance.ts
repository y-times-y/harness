import { type ModelMessage, tool } from "ai";
import { parse } from "yaml";
import { z } from "zod";
import {
	type AgentToolWorkspaceInput,
	resolveToolWorkspace,
} from "./agent-tool-workspace";

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const GUIDANCE_SCRIPT = `import hashlib, json, os, pathlib, re, subprocess, sys
root = pathlib.Path(sys.argv[1]).resolve(strict=True)
relative = pathlib.Path(sys.argv[2])
known_documents = json.loads(sys.argv[3])
archived_documents = json.loads(sys.argv[4])
include_git_ancestors = len(sys.argv) > 5 and sys.argv[5] == '1'
if relative.is_absolute() or '..' in relative.parts or '.git' in relative.parts:
    raise ValueError('Scope must be inside the repository')
scope = (root / relative).resolve()
if not scope.is_relative_to(root):
    raise ValueError('Scope escaped repository')
if scope.is_file() or (not scope.exists() and scope.suffix):
    scope = scope.parent
folders = [root]
folders.extend(reversed([parent for parent in [scope, *scope.parents] if parent != root and parent.is_relative_to(root)]))
# A checkout of a repository subdirectory also inherits the instructions between the Git root and it.
if include_git_ancestors:
    top = subprocess.run(['git', '-C', str(root), 'rev-parse', '--show-toplevel'], capture_output=True, text=True, timeout=10)
    toplevel = pathlib.Path(top.stdout.strip()).resolve() if top.returncode == 0 and top.stdout.strip() else None
    if toplevel is not None and toplevel != root and root.is_relative_to(toplevel):
        folders[:0] = reversed([parent for parent in root.parents if parent.is_relative_to(toplevel)])
instructions = []
remaining = 64000
def fingerprint_and_prefix(path, prefix_limit):
    digest = hashlib.sha256()
    prefix = bytearray()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(65536), b''):
            digest.update(chunk)
            if len(prefix) < prefix_limit:
                prefix.extend(chunk[:prefix_limit - len(prefix)])
    return digest.hexdigest(), bytes(prefix)
# A read-only agent runs as another Linux user: files created under umask 077
# (setup commands, transfers) are unreadable to it. Such a file is skipped and
# named, never a reason to abandon the whole scan.
unreadable = []
def note_unreadable(path):
    try:
        name = pathlib.Path(os.path.relpath(path, root)).as_posix()
    except ValueError:
        return
    if name not in unreadable and len(unreadable) < 50:
        unreadable.append(name)
def is_link(path):
    try:
        return path.is_symlink()
    except OSError:
        return False
def is_regular(path):
    try:
        return path.is_file()
    except OSError:
        note_unreadable(path)
        return False
def read_prefix(path, prefix_limit):
    try:
        return fingerprint_and_prefix(path, prefix_limit)
    except OSError:
        note_unreadable(path)
        return None
for folder in folders:
    for name in ('AGENTS.md', 'CLAUDE.md'):
        path = folder / name
        if is_regular(path) and not is_link(path):
            limit = min(16000, remaining)
            read = read_prefix(path, (limit + 1) * 4)
            if read is None:
                continue
            digest, raw = read
            text = raw.decode('utf-8', errors='replace')
            instructions.append({'path': pathlib.Path(os.path.relpath(path, root)).as_posix(), 'sha256': digest, 'content': text[:limit], 'nextStart': limit if len(text) > limit else None})
            remaining -= limit
documents = []
seen_documents = set()
document_budget = 128000
document_limit_reached = False
# Conservative one-hop prefetch of simple inline local Markdown links. This
# does not interpret arbitrary Markdown, follow network links, or recurse.
for instruction in instructions:
    parent = (root / instruction['path']).parent
    for link in re.findall(r'\\[[^\\]\\n]*\\]\\(([^()\\s]+)\\)', instruction['content']):
        filename = link.split('#', 1)[0]
        relative = pathlib.Path(filename)
        if not filename or ':' in filename or '\\x00' in filename or relative.is_absolute() or relative.suffix.lower() != '.md' or '.git' in relative.parts:
            continue
        requested = parent / relative
        target = requested.resolve()
        if not target.is_relative_to(root) or '.git' in target.relative_to(root).parts or is_link(requested) or not is_regular(target):
            continue
        name = target.relative_to(root).as_posix()
        if name in seen_documents or any(item['path'] == name for item in instructions):
            continue
        if len(documents) == 8:
            document_limit_reached = True
            continue
        seen_documents.add(name)
        limit = min(128000, document_budget)
        read = read_prefix(target, (limit + 1) * 4)
        if read is None:
            continue
        digest, raw = read
        if known_documents.get(name) == digest:
            documents.append({'path': name, 'referencedBy': instruction['path'], 'sha256': digest, 'alreadyInContext': True, 'nextStart': None})
            continue
        archived = archived_documents.get(name)
        if archived and archived['sha256'] == digest:
            documents.append({'path': name, 'referencedBy': instruction['path'], 'sha256': digest, 'previouslyRead': True, 'archivedBody': archived['archivedBody'], 'nextStart': None})
            continue
        text = raw.decode('utf-8', errors='replace')
        content = text[:limit]
        documents.append({'path': name, 'referencedBy': instruction['path'], 'sha256': digest, 'content': content, 'nextStart': limit if len(text) > limit else None})
        document_budget -= len(content)
configuration = []
configuration_budget = 32000
for filename in ('package.json', 'biome.json', 'biome.jsonc', 'tsconfig.json', 'vitest.config.ts', 'vitest.config.mts', 'vitest.config.js'):
    requested = root / filename
    target = requested.resolve()
    if is_link(requested) or not target.is_relative_to(root) or not is_regular(target):
        continue
    limit = min(16000, configuration_budget)
    read = read_prefix(target, (limit + 1) * 4)
    if read is None:
        continue
    digest, raw = read
    if known_documents.get(filename) == digest:
        configuration.append({'path': filename, 'sha256': digest, 'alreadyInContext': True, 'nextStart': None})
        continue
    text = raw.decode('utf-8', errors='replace')
    content = text[:limit]
    configuration.append({'path': filename, 'sha256': digest, 'content': content, 'nextStart': limit if len(text) > limit else None})
    configuration_budget -= len(content)
listing = subprocess.run(['git', '-C', str(root), 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], capture_output=True, timeout=10)
files = listing.stdout.decode(errors='replace').split('\\0') if listing.returncode == 0 else []
scope_files = []
inventory_characters = 0
inventory_truncated = False
for filename in sorted(set(files)):
    path = pathlib.Path(filename)
    if not filename or any(part.startswith('.') for part in path.parts):
        continue
    requested = root / path
    target = requested.resolve()
    if not target.is_relative_to(root) or not target.is_relative_to(scope) or any(part.startswith('.') for part in target.relative_to(root).parts):
        continue
    if is_link(requested) or not is_regular(target):
        continue
    if len(scope_files) == 200 or inventory_characters + len(filename) > 8000:
        inventory_truncated = True
        break
    scope_files.append(filename)
    inventory_characters += len(filename)
skills = []
for filename in sorted(set(files)):
    path = pathlib.Path(filename)
    if len(path.parts) != 4 or path.parts[:2] not in (('.agents', 'skills'), ('.claude', 'skills')) or path.name != 'SKILL.md':
        continue
    target = (root / path).resolve()
    if not target.is_relative_to(root) or is_link(root / path) or not is_regular(target):
        continue
    read = read_prefix(target, 4096)
    if read is None:
        continue
    digest, raw = read
    skills.append({'path': filename, 'sha256': digest, 'header': raw.decode('utf-8', errors='replace')})
    if len(skills) >= 100:
        break
revision = subprocess.run(['git', '-C', str(root), 'rev-parse', 'HEAD'], capture_output=True, text=True, timeout=10)
for instruction in instructions:
    if instruction['nextStart'] is None and known_documents.get(instruction['path']) == instruction['sha256']:
        del instruction['content']
        instruction['alreadyInContext'] = True
# Every nested instruction file, so a model need not probe directories for them.
listed = subprocess.run(['git', '-C', str(root), 'ls-files', '-co', '--exclude-standard', '--', '*AGENTS.md', '*CLAUDE.md'], capture_output=True, text=True, timeout=10)
nested = sorted(line for line in listed.stdout.splitlines() if '/' in line and pathlib.PurePosixPath(line).name in ('AGENTS.md', 'CLAUDE.md')) if listed.returncode == 0 else None
print(json.dumps({'scope': scope.relative_to(root).as_posix(), 'revision': revision.stdout.strip() if revision.returncode == 0 else None, 'nestedInstructionFiles': nested[:50] if nested is not None else None, 'nestedInstructionFilesTruncated': nested is not None and len(nested) > 50, 'instructions': instructions, 'referencedDocuments': documents, 'configuration': configuration, 'documentLimitReached': document_limit_reached, 'skills': skills, 'skillLimitReached': len(skills) == 100, 'scopeFiles': scope_files, 'scopeFilesTruncated': inventory_truncated, 'scopeFilesUnavailable': listing.returncode != 0, 'unreadableFiles': unreadable}, ensure_ascii=False))`;

type GuidancePacket = {
	scope: string;
	scopeFiles: string[];
	scopeFilesTruncated: boolean;
	revision: string | null;
	nestedInstructionFiles: string[] | null;
	nestedInstructionFilesTruncated: boolean;
	instructions: {
		path: string;
		sha256: string;
		content?: string;
		alreadyInContext?: true;
		nextStart: number | null;
	}[];
	skills: { path: string; sha256: string; header: string }[];
	skillLimitReached: boolean;
	configuration: {
		path: string;
		sha256: string;
		content?: string;
		alreadyInContext?: true;
		nextStart: number | null;
	}[];
	referencedDocuments: {
		path: string;
		referencedBy: string;
		sha256: string;
		content?: string;
		alreadyInContext?: true;
		previouslyRead?: true;
		archivedBody?: z.infer<typeof archivedGuidanceBody>;
		nextStart: number | null;
	}[];
	documentLimitReached: boolean;
	/** Git could not list the checkout's files; scopeFiles is empty. */
	scopeFilesUnavailable?: boolean;
	/** Files this agent's Linux user cannot read (a read-only agent), skipped. */
	unreadableFiles?: string[];
};

/**
 * The scan itself could not run (no checkout, scope outside it, no python3):
 * a workspace condition, never a model or provider failure.
 */
export class RepositoryGuidanceUnavailable extends Error {
	readonly reason: string;
	constructor(reason: string) {
		super(`Could not safely inspect repository guidance: ${reason}`);
		this.name = "RepositoryGuidanceUnavailable";
		this.reason = reason;
	}
}

/** The last line of the scan's stderr (the Python exception), bounded. */
function guidanceFailureReason(stderr: string, exitCode: number) {
	const line = stderr
		.split(/\r?\n/)
		.map((entry) => entry.trim())
		.filter(Boolean)
		.at(-1);
	return (line ?? `exit code ${exitCode}`).slice(0, 300);
}

const archivedGuidanceBody = z.object({
	reference: z.string().regex(/^context-[0-9a-f-]{36}$/),
	messageIndex: z.number().int().nonnegative(),
	toolCallId: z.string().min(1),
	characters: z.number().int().min(16001),
	instruction: z.string(),
});

/** A matching current hash can reuse a prior complete-read receipt, not its absent body. */
export function archivedGuidanceDocuments(messages: readonly ModelMessage[]) {
	const known: Record<
		string,
		{ sha256: string; archivedBody: z.infer<typeof archivedGuidanceBody> }
	> = Object.create(null);
	for (const message of messages) {
		if (message.role !== "tool") continue;
		for (const part of message.content) {
			if (
				part.type !== "tool-result" ||
				part.toolName !== "read_repository_guidance" ||
				part.output.type !== "json"
			)
				continue;
			const packet = z
				.object({ referencedDocuments: z.array(z.unknown()) })
				.safeParse(part.output.value);
			if (!packet.success) continue;
			for (const entry of packet.data.referencedDocuments) {
				const document = z
					.object({
						path: z.string(),
						sha256: z.string().regex(/^[a-f0-9]{64}$/),
						nextStart: z.null(),
						archivedBody: archivedGuidanceBody,
					})
					.safeParse(entry);
				if (document.success) known[document.data.path] = document.data;
			}
		}
	}
	return known;
}

const completeGuidanceDocument = z.object({
	path: z.string(),
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
	content: z.string(),
	nextStart: z.null(),
});

/** Only complete bodies still in the active transcript may suppress another copy. */
export function knownGuidanceDocuments(messages: readonly ModelMessage[]) {
	const known: Record<string, string> = Object.create(null);
	for (const message of messages) {
		if (message.role !== "tool" || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (
				part.type !== "tool-result" ||
				part.toolName !== "read_repository_guidance" ||
				part.output.type !== "json"
			)
				continue;
			const packet = z
				.object({
					instructions: z.array(z.unknown()).optional(),
					referencedDocuments: z.array(z.unknown()).optional(),
					configuration: z.array(z.unknown()).optional(),
				})
				.safeParse(part.output.value);
			if (!packet.success) continue;
			for (const entry of [
				...(packet.data.instructions ?? []),
				...(packet.data.referencedDocuments ?? []),
				...(packet.data.configuration ?? []),
			]) {
				const document = completeGuidanceDocument.safeParse(entry);
				if (document.success) known[document.data.path] = document.data.sha256;
			}
		}
	}
	return known;
}

/** Reuse only an identical inventory body retained in the active transcript, after a fresh disk scan. */
function inventoryAlreadyInContext(
	messages: readonly ModelMessage[],
	packet: Pick<GuidancePacket, "scope" | "scopeFiles" | "scopeFilesTruncated">,
) {
	const inventory = z.object({
		scope: z.string(),
		scopeFiles: z.array(z.string()),
		scopeFilesTruncated: z.boolean(),
		scopeFilesAlreadyInContext: z.literal(false).optional(),
	});
	for (const message of messages) {
		if (message.role !== "tool") continue;
		for (const part of message.content) {
			if (
				part.type !== "tool-result" ||
				part.toolName !== "read_repository_guidance" ||
				part.output.type !== "json"
			)
				continue;
			const previous = inventory.safeParse(part.output.value);
			if (
				previous.success &&
				previous.data.scope === packet.scope &&
				previous.data.scopeFilesTruncated === packet.scopeFilesTruncated &&
				JSON.stringify(previous.data.scopeFiles) ===
					JSON.stringify(packet.scopeFiles)
			)
				return true;
		}
	}
	return false;
}

/** Parsed name and description from each skill's frontmatter, never its body. */
function skillMetadata(packet: GuidancePacket) {
	return packet.skills.map(({ header, ...source }) => {
		const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(
			header,
		)?.[1];
		try {
			const metadata: unknown = frontmatter
				? parse(frontmatter, { maxAliasCount: 0 })
				: null;
			const parsed = z
				.object({
					name: z.string().min(1).max(100),
					description: z.string().min(1).max(2000),
				})
				.safeParse(metadata);
			return parsed.success
				? { ...source, ...parsed.data }
				: { ...source, metadataUnavailable: true as const };
		} catch {
			return { ...source, metadataUnavailable: true as const };
		}
	});
}

/** Scan the checkout's instructions, referenced docs, skills and root configuration for a scope. */
export async function inspectRepositoryGuidance(
	input: AgentToolWorkspaceInput,
	options: {
		scope: string;
		messages?: readonly ModelMessage[];
		/** Also read AGENTS.md/CLAUDE.md between the Git root and a subdirectory checkout. */
		gitAncestors?: boolean;
	},
) {
	const { machines, vm, cwd } = await resolveToolWorkspace(input);
	const messages = options.messages ?? [];
	const result = await machines.exec(
		vm,
		`python3 -c ${quote(GUIDANCE_SCRIPT)} ${quote(cwd)} ${quote(options.scope)} ${quote(JSON.stringify(knownGuidanceDocuments(messages)))} ${quote(JSON.stringify(archivedGuidanceDocuments(messages)))}${options.gitAncestors ? " 1" : ""}`,
		20_000,
	);
	if (result.exitCode)
		throw new RepositoryGuidanceUnavailable(
			guidanceFailureReason(result.stderr, result.exitCode),
		);
	const packet = JSON.parse(result.stdout) as GuidancePacket;
	return { ...packet, skills: skillMetadata(packet) };
}

export type RepositoryGuidance = Awaited<
	ReturnType<typeof inspectRepositoryGuidance>
>;

/** Fresh revision and source hashes make guidance verifiable after branch switches or compaction. */
export function repositoryGuidanceTool(
	input: AgentToolWorkspaceInput & { signal: AbortSignal },
) {
	return tool({
		description:
			"Read root and ancestor AGENTS.md/CLAUDE.md instructions for a repository-relative scope, plus available skill names and descriptions. Prefetches up to eight documents referenced by simple inline local .md links in those instructions, bounded to 128,000 total characters, without recursion or network access. Check referencedDocuments and nextStart before rereading a document: complete bodies are already supplied. Unreferenced skills stay deferred; read matching skill bodies when needed. This is not exhaustive Markdown link parsing; follow other required references yourself. Call before implementation; nested instructions apply only to their directory. nestedInstructionFiles lists every nested AGENTS.md/CLAUDE.md in the repository (null when unknown): read a nested scope only for a listed path; an empty list means no other directory has guidance. Source hashes and revision describe this checkout. Follow every required incomplete page with read_file; documentLimitReached means additional links were not prefetched. Includes bounded root package/build/test/format configuration (32,000 total characters) with hashes and continuation cursors; configuration previews are not full bodies when nextStart is non-null. alreadyInContext marks only matching complete bodies still in the current transcript.",
		inputSchema: z.object({ scope: z.string().min(1).max(2048).default(".") }),
		execute: async ({ scope = "." }, options) => {
			input.signal.throwIfAborted();
			const packet = await inspectRepositoryGuidance(input, {
				scope,
				messages: options.messages,
			});
			return {
				...packet,
				...(inventoryAlreadyInContext(options.messages, packet)
					? {
							scopeFiles: [],
							scopeFilesAlreadyInContext: true,
							scopeFileCount: packet.scopeFiles.length,
						}
					: {}),
			};
		},
	});
}
