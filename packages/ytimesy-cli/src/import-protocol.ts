/**
 * The wire contract between the CLI and ytimesy's /api/local-import/* routes:
 * the request bodies, the import plan and the rules both sides must agree on.
 * The app (src/domain/local-import.ts) re-exports it; the CLI's fake server
 * checks the CLI's requests against it.
 */
import { z } from "zod";
import { LOCAL_AGENTS } from "./local-agents.ts";

export const localAgent = z.enum(LOCAL_AGENTS);

/** 32 symbols (no I, O, 0, 1): each random byte's low 5 bits pick one without bias. */
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_PATTERN = /^YTM-([A-Z2-9]{4})-([A-Z2-9]{4})-([A-Z2-9]{4})$/;

/** The code as typed or pasted (any case, spaces, with or without dashes), or null. */
export function normalizeImportCode(value: string): string | null {
	const compact = value.toUpperCase().replace(/[\s-]/g, "");
	const body = compact.startsWith("YTM") ? compact.slice(3) : compact;
	if (!/^[A-Z2-9]{12}$/.test(body)) return null;
	const code = `YTM-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8)}`;
	return CODE_PATTERN.test(code) &&
		[...body].every((symbol) => CODE_ALPHABET.includes(symbol))
		? code
		: null;
}

// ---- request shapes ----------------------------------------------------------

/** At most this many sessions per import, and this many bytes of handoff context. */
export const LOCAL_IMPORT_LIMITS = {
	groups: 200,
	sessions: 500,
	secrets: 200,
	handoffContextChars: 60_000,
} as const;

const isoDate = z.iso.datetime({ offset: true });
const repositoryFullName = z
	.string()
	.regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/);
const localPath = z.string().min(1).max(1024);

export const startRequest = z
	.object({
		code: z.string().min(1).max(40),
		agent: localAgent.optional(),
		cliVersion: z.string().max(40).optional(),
	})
	.strict();

export const planRequest = z
	.object({
		groups: z
			.array(
				z
					.object({
						/** The folder as the CLI shows it to the user. */
						folder: localPath,
						git: z
							.object({
								/** `owner/name` of a github.com remote, or null for another host or none. */
								repository: repositoryFullName.nullable(),
								/** The remote's host when it is not github.com (for the reason shown). */
								host: z.string().max(255).nullable(),
								branch: z.string().max(255).nullable(),
							})
							.strict()
							.nullable(),
						sessions: z.number().int().min(0).max(LOCAL_IMPORT_LIMITS.sessions),
						bytes: z.number().int().min(0).max(1e12),
						tools: z.array(localAgent).max(LOCAL_AGENTS.length),
						latestAt: isoDate.optional(),
					})
					.strict(),
			)
			.max(LOCAL_IMPORT_LIMITS.groups),
	})
	.strict();
export type PlanRequest = z.infer<typeof planRequest>;
export type PlanGroup = PlanRequest["groups"][number];

/**
 * Makes a project of a GitHub repository the ytimesy app can reach: one the
 * plan found without a project, or one the CLI just created with the user's
 * own GitHub login (`gh`). ytimesy never creates repositories itself.
 */
export const createProjectRequest = z
	.object({
		folder: localPath,
		repository: repositoryFullName,
	})
	.strict();

export const secretsRequest = z
	.object({
		projectId: z.uuid(),
		variables: z
			.array(
				z
					.object({
						name: z.string().min(1).max(128),
						value: z.string().max(8192),
						source: z.enum([".env", ".env.local"]),
					})
					.strict(),
			)
			.max(LOCAL_IMPORT_LIMITS.secrets),
	})
	.strict();

const toolCall = z
	.object({
		kind: z.enum(["shell", "edit", "write", "read", "search", "other"]),
		name: z.string().max(200),
		input: z.string().max(20_000),
		command: z.string().max(20_000).optional(),
		output: z.string().max(20_000).optional(),
		exitCode: z.number().int().optional(),
		isError: z.boolean().optional(),
		paths: z.array(z.string().max(1024)).max(200),
		changedPaths: z.array(z.string().max(1024)).max(200),
	})
	.strict();

const turn = z
	.object({
		role: z.enum(["user", "assistant"]),
		text: z.string().max(200_000),
		at: isoDate.optional(),
		toolCalls: z.array(toolCall).max(500),
		synthetic: z.enum(["compaction-summary", "trim-digest"]).optional(),
	})
	.strict();

/**
 * One session's handoff, as the CLI's local-sessions builds it: the session's
 * metadata, a summary of trimmed turns (as synthetic turns) and the newest
 * turns within the CLI's budget, plus what it ran and touched.
 */
export const handoffDocument = z
	.object({
		version: z.literal(1),
		tool: localAgent,
		sessionId: z.string().min(1).max(200),
		title: z.string().max(300).optional(),
		cwd: localPath,
		gitBranch: z.string().max(255).optional(),
		model: z.string().max(200).optional(),
		startedAt: isoDate.optional(),
		updatedAt: isoDate,
		/** Turns in the whole session, not only those sent. */
		totalTurns: z.number().int().min(0).max(1_000_000),
		turns: z.array(turn).max(2000),
		successfulCommands: z.array(z.string().max(2000)).max(200),
		files: z
			.object({
				edited: z.array(z.string().max(1024)).max(1000),
				written: z.array(z.string().max(1024)).max(1000),
				read: z.array(z.string().max(1024)).max(1000),
			})
			.strict(),
	})
	.strict();
export type HandoffDocument = z.infer<typeof handoffDocument>;

export const sessionUploadRequest = z
	.object({
		projectId: z.uuid(),
		handoff: handoffDocument,
		/** How many sessions this import uploads in all, for the card's progress. */
		total: z.number().int().min(1).max(LOCAL_IMPORT_LIMITS.sessions).optional(),
	})
	.strict();

/** Pushed and skipped paths finish takes, each list. */
export const FINISH_LISTED_FILES = 200;

/** What the card and the CLI say once an import was cancelled. */
export const IMPORT_CANCELLED_MESSAGE = "Import cancelled.";

export const finishRequest = z
	.object({
		projectId: z.uuid(),
		/** The imported session (tool + id) the chat continues. */
		continue: z
			.object({ tool: localAgent, sessionId: z.string().min(1).max(200) })
			.strict(),
		/** The branch the CLI pushed, `ytimesy/...`. */
		branch: z.string().min(1).max(255),
		/** `owner/name` it was pushed to; needed only when the project has several. */
		repository: repositoryFullName.optional(),
		/** How many files the CLI pushed and skipped (the card's tooltip says so). */
		pushedFiles: z.number().int().min(0).max(1_000_000).default(0),
		skippedFiles: z.number().int().min(0).max(1_000_000).default(0),
		/** Their paths, at most FINISH_LISTED_FILES each (the handoff card's details). */
		pushedPaths: z.array(localPath).max(FINISH_LISTED_FILES).default([]),
		skippedPaths: z.array(localPath).max(FINISH_LISTED_FILES).default([]),
	})
	.strict();

/** A pushed handoff branch: `ytimesy/<name>`, a valid, unambiguous Git ref. */
export function handoffBranch(value: string): string | null {
	const branch = value.trim();
	if (!/^ytimesy\/[A-Za-z0-9._/-]{1,200}$/.test(branch)) return null;
	if (
		branch.includes("..") ||
		branch.includes("//") ||
		branch.endsWith("/") ||
		branch.endsWith(".") ||
		branch.endsWith(".lock") ||
		branch.split("/").some((part) => part.startsWith("."))
	)
		return null;
	return branch;
}

// ---- the plan ----------------------------------------------------------------

export type PlanProject = {
	readonly id: string;
	readonly name: string;
	readonly repositories: readonly string[];
};

export type PlanEntry = {
	readonly folder: string;
	readonly sessions: number;
} & (
	| {
			/**
			 * Import into the project that holds the repository. `projectId` is
			 * null when the app reaches the repository but no project holds it
			 * yet: create-project makes one (named `projectName`) first.
			 */
			readonly action: "import";
			readonly projectId: string | null;
			readonly projectName: string;
			readonly newProject: boolean;
			readonly repository: string;
			readonly visibility: "public" | "private" | "unknown";
	  }
	| {
			/** The GitHub app has no access to this repository. */
			readonly action: "grant-access";
			readonly repository: string;
			readonly connectUrl: string;
	  }
	| {
			/**
			 * No GitHub repository: create a private one (the CLI does, with the
			 * user's own GitHub login), attach to a project, or skip.
			 */
			readonly action: "no-repository";
			readonly reason: "no-git" | "no-remote" | "other-host";
			readonly suggestedName: string;
			readonly attachTo: readonly { id: string; name: string }[];
	  }
);

/** A repository name GitHub accepts, from a local folder's last segment. */
export function suggestedRepositoryName(folder: string) {
	const base = folder.split(/[\\/]/).filter(Boolean).pop() ?? "";
	const name = base
		.replace(/[^A-Za-z0-9_.-]+/g, "-")
		.replace(/^[.-]+|-+$/g, "")
		.slice(0, 100);
	return name || "imported-project";
}

/**
 * What the server answers for each folder of local sessions: import into the
 * project that holds its repository (or a new project, when the app reaches
 * the repository but no project holds it), grant the app access, or (no
 * GitHub repository) create one, attach or skip.
 */
export function planLocalImport(input: {
	readonly groups: readonly PlanGroup[];
	readonly projects: readonly PlanProject[];
	/** Repositories the GitHub app can reach, with their visibility when known. */
	readonly reachable: ReadonlyMap<string, boolean | undefined>;
	readonly installationUrl: string;
}): PlanEntry[] {
	const reachable = new Map(
		[...input.reachable].map(([name, isPrivate]) => [
			name.toLowerCase(),
			isPrivate,
		]),
	);
	const visibility = (name: string) => {
		const isPrivate = reachable.get(name.toLowerCase());
		return isPrivate === undefined
			? "unknown"
			: isPrivate
				? "private"
				: "public";
	};
	const attachTo = input.projects.map(({ id, name }) => ({ id, name }));
	return input.groups.map((group): PlanEntry => {
		const base = { folder: group.folder, sessions: group.sessions };
		const repository = group.git?.repository ?? null;
		if (repository) {
			const project = input.projects.find((candidate) =>
				candidate.repositories.some(
					(name) => name.toLowerCase() === repository.toLowerCase(),
				),
			);
			if (project)
				return {
					...base,
					action: "import",
					projectId: project.id,
					projectName: project.name,
					newProject: false,
					repository,
					visibility: visibility(repository),
				};
			if (reachable.has(repository.toLowerCase()))
				return {
					...base,
					action: "import",
					projectId: null,
					projectName: repository.split("/")[1] ?? repository,
					newProject: true,
					repository,
					visibility: visibility(repository),
				};
			return {
				...base,
				action: "grant-access",
				repository,
				connectUrl: input.installationUrl,
			};
		}
		return {
			...base,
			action: "no-repository",
			reason: !group.git
				? "no-git"
				: group.git.host
					? "other-host"
					: "no-remote",
			suggestedName: suggestedRepositoryName(group.folder),
			attachTo,
		};
	});
}
