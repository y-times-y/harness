import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PlanGroupRequest } from "./api.ts";
import type { LocalAgent } from "./local-agents.ts";
import { gitIdentity, sameRepository } from "./local-sessions/git.ts";
import {
	type AgentTool,
	type CallingAgent,
	discoverAllSessions,
	exportFullTranscript,
	type FolderGit,
	findSessionToImport,
	type LocalSession,
	normalizeRemote,
	readSession,
	readSessionActivity,
	redact,
	resolveRepositoryRoot,
	type SessionRef,
	trimImportTail,
	trimToBudget,
} from "./local-sessions/index.ts";
import { canonicalPath, isPathInside } from "./local-sessions/io.ts";
import { type TarEntry, tarGz } from "./tar.ts";

/**
 * The local sessions an import can take: the calling agent's own session,
 * every session of this project, or every session on the machine, grouped by
 * folder (a Git work tree, or the folder itself), plus each session's handoff
 * document and full-transcript archive as the API takes them.
 */

export type Scope = "session" | "project" | "machine";
export const SCOPES: readonly Scope[] = ["session", "project", "machine"];

/** Server-side limit on sessions per import. */
export const MAX_SESSIONS = 500;
export const MAX_GROUPS = 200;

export type Candidate = {
	readonly tool: AgentTool;
	readonly id: string;
	readonly cwd: string;
	readonly title?: string;
	readonly updatedAt: number;
	readonly messages: number;
	readonly bytes: number;
	readonly ref: SessionRef;
	/** The group: the Git work tree root, or the folder itself. */
	readonly folder: string;
	readonly git: FolderGit | null;
};

export type Discovery = {
	/** The session to continue, and why it was picked. */
	readonly continued: {
		readonly candidate: Candidate;
		readonly reason: "caller-session" | "caller-latest" | "latest";
	} | null;
	readonly caller: CallingAgent | undefined;
	/** The folder of the session to continue (its work tree root). */
	readonly folder: string;
	readonly all: readonly Candidate[];
	/** Sessions left out because their store does not record a folder. */
	readonly withoutFolder: number;
	/** Agents whose sessions this Node cannot read (needs node:sqlite). */
	readonly needsNewerNode: readonly AgentTool[];
};

/** The server knows the Cursor CLI and the Cursor app as one agent. */
export function localAgent(tool: AgentTool): LocalAgent {
	return tool === "cursor-agent" ? "cursor" : tool;
}

export function sessionKey(candidate: Pick<Candidate, "tool" | "id">) {
	return `${localAgent(candidate.tool)}:${candidate.id}`;
}

function folderGit(cwd: string): FolderGit | null {
	const identity = path.isAbsolute(cwd) ? gitIdentity(cwd) : undefined;
	return identity
		? {
				root: identity.root,
				remote: identity.remote,
				remoteUrl: identity.remoteUrl,
				branch: identity.branch,
			}
		: null;
}

function candidateFromRef(ref: SessionRef): Candidate {
	const cwd = ref.cwd ? canonicalPath(ref.cwd) : "";
	const git = cwd ? folderGit(cwd) : null;
	let bytes = 0;
	try {
		const stat = fs.statSync(ref.location);
		bytes = stat.isFile() ? stat.size : 0;
	} catch {
		bytes = 0;
	}
	return {
		tool: ref.tool,
		id: ref.id,
		cwd,
		updatedAt: ref.updatedAt,
		messages: 0,
		bytes,
		ref,
		folder: git?.root ?? cwd,
		git,
	};
}

export function discover(input: {
	readonly cwd: string;
	readonly home: string;
	readonly env: Record<string, string | undefined>;
	readonly ancestors?: () => AgentTool[];
	/** Whether node:sqlite works (default: detected); tests pin it. */
	readonly sqlite?: boolean;
}): Discovery {
	const machine = discoverAllSessions({
		home: input.home,
		...(input.sqlite === undefined ? {} : { sqlite: input.sqlite }),
	});
	const all: Candidate[] = [];
	let withoutFolder = 0;
	for (const session of machine.sessions) {
		if (session.messageCountExact && session.messageCount === 0) continue;
		if (!session.cwd || !path.isAbsolute(session.cwd)) {
			withoutFolder++;
			continue;
		}
		const cwd = canonicalPath(session.cwd);
		const git = session.git === "none" ? null : session.git;
		all.push({
			tool: session.tool,
			id: session.id,
			cwd,
			title: session.title,
			updatedAt: session.updatedAt,
			messages: session.messageCount,
			bytes: session.sizeBytes,
			ref: session.ref,
			folder: git?.root ?? cwd,
			git,
		});
	}
	const root = resolveRepositoryRoot(input.cwd);
	const selection = findSessionToImport(root, {
		home: input.home,
		env: input.env,
		...(input.ancestors ? { ancestors: input.ancestors } : {}),
	});
	const found = selection
		? (all.find(
				(candidate) =>
					candidate.tool === selection.ref.tool &&
					candidate.id === selection.ref.id,
			) ?? candidateFromRef(selection.ref))
		: null;
	// The work to push is the repository the command runs in (an agent may
	// work in a worktree or another checkout than where its session started);
	// outside a repository, the session's own folder.
	const here = folderGit(canonicalPath(input.cwd));
	const folder = here?.root ?? (found?.cwd ? found.folder : root);
	return {
		continued:
			selection && found
				? {
						candidate: { ...found, folder, git: here ?? found.git },
						reason: selection.reason,
					}
				: null,
		caller: selection?.caller,
		folder,
		all,
		withoutFolder,
		needsNewerNode: machine.needsNewerNode,
	};
}

/**
 * The sessions a scope takes, newest first, the continued one always included;
 * at most MAX_SESSIONS unless `cap` is false (for counting).
 */
export function scopeSessions(
	discovery: Discovery,
	scope: Scope,
	cap = true,
): Candidate[] {
	const continued = discovery.continued?.candidate;
	let chosen: Candidate[];
	if (scope === "session") chosen = continued ? [continued] : [];
	else if (scope === "machine") chosen = [...discovery.all];
	else {
		const identity = gitIdentity(discovery.folder);
		chosen = discovery.all.filter((candidate) =>
			identity && candidate.git
				? sameRepository(identity, gitIdentity(candidate.git.root))
				: isPathInside(candidate.cwd, discovery.folder),
		);
	}
	if (continued) {
		// The continued session belongs to the folder being continued.
		const key = sessionKey(continued);
		chosen = chosen.filter((candidate) => sessionKey(candidate) !== key);
		chosen.push(continued);
	}
	chosen.sort((a, b) => b.updatedAt - a.updatedAt);
	if (!cap || chosen.length <= MAX_SESSIONS) return chosen;
	const kept = chosen.slice(0, MAX_SESSIONS);
	if (continued && !kept.includes(continued)) kept[kept.length - 1] = continued;
	return kept;
}

export type Group = {
	readonly folder: string;
	readonly git: FolderGit | null;
	readonly candidates: readonly Candidate[];
	readonly bytes: number;
	readonly latestAt: number;
	/** Holds the session being continued. */
	readonly continued: boolean;
};

/** Sessions by folder: the continued folder first, then newest first; at most MAX_GROUPS. */
export function groupSessions(
	candidates: readonly Candidate[],
	continuedFolder: string,
): { groups: Group[]; droppedGroups: number } {
	const byFolder = new Map<string, Candidate[]>();
	for (const candidate of candidates) {
		const list = byFolder.get(candidate.folder) ?? [];
		list.push(candidate);
		byFolder.set(candidate.folder, list);
	}
	const groups = [...byFolder].map(
		([folder, list]): Group => ({
			folder,
			git: list.find((candidate) => candidate.git)?.git ?? null,
			candidates: list,
			bytes: list.reduce((sum, candidate) => sum + candidate.bytes, 0),
			latestAt: Math.max(...list.map((candidate) => candidate.updatedAt)),
			continued: folder === continuedFolder,
		}),
	);
	groups.sort(
		(a, b) =>
			Number(b.continued) - Number(a.continued) || b.latestAt - a.latestAt,
	);
	return {
		groups: groups.slice(0, MAX_GROUPS),
		droppedGroups: Math.max(0, groups.length - MAX_GROUPS),
	};
}

const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/** The remote's host, or null for a local path or something unparseable. */
export function remoteHost(url: string | undefined): string | null {
	if (!url) return null;
	const trimmed = url.trim();
	const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/\/)(.+)$/.exec(trimmed);
	if (scp && !/^[a-z]+:\/\//i.test(trimmed))
		return scp[1]?.toLowerCase() ?? null;
	try {
		const parsed = new URL(trimmed);
		return parsed.protocol === "file:" ? null : parsed.hostname.toLowerCase();
	} catch {
		return null;
	}
}

/** `owner/name` on github.com, or the other host the remote is on. */
export function remoteRepository(git: FolderGit | null): {
	repository: string | null;
	host: string | null;
} {
	const host = remoteHost(git?.remoteUrl);
	if (!host) return { repository: null, host: null };
	if (host === "github.com" || host.endsWith(".github.com")) {
		const repository = normalizeRemote(git?.remoteUrl) ?? "";
		return REPOSITORY.test(repository)
			? { repository, host: null }
			: { repository: null, host };
	}
	return { repository: null, host };
}

export function planGroupRequest(group: Group): PlanGroupRequest {
	const remote = remoteRepository(group.git);
	return {
		folder: group.folder,
		git: group.git
			? {
					repository: remote.repository,
					host: remote.host,
					branch: group.git.branch ?? null,
				}
			: null,
		sessions: group.candidates.length,
		bytes: Math.round(group.bytes),
		tools: [
			...new Set(
				group.candidates.map((candidate) => localAgent(candidate.tool)),
			),
		],
		...(group.latestAt > 0
			? { latestAt: new Date(group.latestAt).toISOString() }
			: {}),
	};
}

// ---- the handoff document ----------------------------------------------------

/** Turn characters read for a handoff; the rest stays in the full transcript. */
const HANDOFF_BUDGET_CHARS = 300_000;
/** The sessions route takes 2 MB; stay under it with room for the envelope. */
const HANDOFF_MAX_JSON_BYTES = 1_900_000;
/** The import command itself, as the agent ran it. */
export const IMPORT_COMMAND = /ytimesy(?:@[\w.-]+)?\s+continue\b/;

const clip = (text: string, limit: number) =>
	text.length > limit ? text.slice(0, limit) : text;

function isoOrUndefined(value: string | number | undefined) {
	if (value === undefined || value === "") return undefined;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function clipList(list: readonly string[], count: number, chars: number) {
	return list.slice(0, count).map((item) => clip(item, chars));
}

export type HandoffDocument = {
	version: 1;
	tool: LocalAgent;
	sessionId: string;
	title?: string;
	cwd: string;
	gitBranch?: string;
	model?: string;
	startedAt?: string;
	updatedAt: string;
	totalTurns: number;
	turns: {
		role: "user" | "assistant";
		text: string;
		at?: string;
		toolCalls: {
			kind: "shell" | "edit" | "write" | "read" | "search" | "other";
			name: string;
			input: string;
			command?: string;
			output?: string;
			exitCode?: number;
			isError?: boolean;
			paths: string[];
			changedPaths: string[];
		}[];
		synthetic?: "compaction-summary" | "trim-digest";
	}[];
	successfulCommands: string[];
	files: { edited: string[]; written: string[]; read: string[] };
};

function handoffFrom(
	candidate: Candidate,
	session: LocalSession,
	activity: ReturnType<typeof readSessionActivity>,
): HandoffDocument {
	const turns = session.turns.slice(-2000).map((turn) => {
		const at = isoOrUndefined(turn.at);
		return {
			role: turn.role,
			text: clip(turn.text, 200_000),
			...(at ? { at } : {}),
			toolCalls: turn.toolCalls.slice(-500).map((call) => ({
				kind: call.kind,
				name: clip(call.name, 200),
				input: clip(call.input, 20_000),
				...(call.command !== undefined
					? { command: clip(call.command, 20_000) }
					: {}),
				...(call.output !== undefined
					? { output: clip(call.output, 20_000) }
					: {}),
				...(Number.isInteger(call.exitCode) ? { exitCode: call.exitCode } : {}),
				...(call.isError !== undefined ? { isError: call.isError } : {}),
				paths: clipList(call.paths, 200, 1024),
				changedPaths: clipList(call.changedPaths, 200, 1024),
			})),
			...(turn.synthetic ? { synthetic: turn.synthetic } : {}),
		};
	});
	const title = (session.title ?? candidate.title)?.trim();
	const startedAt = isoOrUndefined(session.startedAt);
	const counted = session.turns.filter((turn) => !turn.synthetic).length;
	return {
		version: 1,
		tool: localAgent(candidate.tool),
		sessionId: clip(candidate.id, 200),
		...(title ? { title: clip(title, 300) } : {}),
		cwd: clip(session.cwd || candidate.cwd, 1024),
		...(session.gitBranch ? { gitBranch: clip(session.gitBranch, 255) } : {}),
		...(session.model ? { model: clip(session.model, 200) } : {}),
		...(startedAt ? { startedAt } : {}),
		updatedAt:
			isoOrUndefined(session.updatedAt || candidate.updatedAt) ??
			new Date().toISOString(),
		totalTurns: Math.min(Math.max(candidate.messages, counted), 1_000_000),
		turns,
		successfulCommands: clipList(
			activity.successfulCommands.filter(
				(command) => !IMPORT_COMMAND.test(command),
			),
			200,
			2000,
		),
		files: {
			edited: clipList(activity.files.edited, 1000, 1024),
			written: clipList(activity.files.written, 1000, 1024),
			read: clipList(activity.files.read, 1000, 1024),
		},
	};
}

/**
 * One session's handoff: the newest turns within the budget (older ones as a
 * digest), without the tail about this import, its successful commands and
 * touched files, with every given secret value redacted. Shrinks the budget
 * until the JSON fits the sessions route.
 */
export function buildHandoff(
	candidate: Candidate,
	options: {
		readonly home: string;
		readonly redactValues: readonly string[];
		/** When this import started; later turns are about the import. */
		readonly importStartedAt: number;
	},
): HandoffDocument {
	const activity = readSessionActivity(candidate.ref, {
		home: options.home,
		...(candidate.cwd ? { root: resolveRepositoryRoot(candidate.cwd) } : {}),
	});
	let budget = HANDOFF_BUDGET_CHARS;
	for (;;) {
		const session = readSession(
			candidate.ref,
			{ budgetChars: budget },
			options.home,
		);
		const tail = trimImportTail(session.turns, {
			startedAt: options.importStartedAt,
			command: IMPORT_COMMAND,
		});
		const turns = trimToBudget(tail, budget);
		const redacted = redact(
			{ ...session, turns, title: session.title ?? candidate.title, activity },
			options.redactValues,
		);
		const handoff = handoffFrom(candidate, redacted, redacted.activity);
		if (
			Buffer.byteLength(JSON.stringify(handoff)) <= HANDOFF_MAX_JSON_BYTES ||
			budget < 5_000
		)
			return handoff;
		budget = Math.floor(budget / 2);
	}
}

// ---- the full transcript archive -------------------------------------------

/** The transcript route takes 25 MB per session. */
export const TRANSCRIPT_MAX_BYTES = 25 * 1024 * 1024;

/**
 * The session's full transcript as the server unpacks it: a gzip tar with
 * transcript.md and transcript-images/. Images are dropped when the archive
 * would be too large; null when even the text is.
 */
export function buildTranscriptArchive(
	candidate: Candidate,
	options: { readonly home: string; readonly redactValues: readonly string[] },
): { archive: Buffer; images: number; imagesDropped: boolean } | null {
	const directory = fs.mkdtempSync(
		path.join(os.tmpdir(), "ytimesy-transcript-"),
	);
	try {
		const outputFile = path.join(directory, "transcript.md");
		const result = exportFullTranscript(candidate.ref, {
			outputFile,
			imagesDirectory: path.join(directory, "transcript-images"),
			redactValues: options.redactValues,
			home: options.home,
		});
		const text: TarEntry = {
			name: "transcript.md",
			type: "file",
			data: fs.readFileSync(outputFile),
		};
		const images: TarEntry[] = result.images.length
			? [
					{ name: "transcript-images", type: "directory" },
					...result.images.map(
						(image): TarEntry => ({
							name: image.split(path.sep).join("/"),
							type: "file",
							data: fs.readFileSync(path.join(directory, image)),
						}),
					),
				]
			: [];
		const full = tarGz([text, ...images]);
		if (full.byteLength <= TRANSCRIPT_MAX_BYTES)
			return {
				archive: full,
				images: result.images.length,
				imagesDropped: false,
			};
		const textOnly = tarGz([text]);
		if (textOnly.byteLength <= TRANSCRIPT_MAX_BYTES)
			return { archive: textOnly, images: 0, imagesDropped: true };
		return null;
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
}
