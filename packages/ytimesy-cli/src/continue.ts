import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ApiError, ImportApi, type PlanEntry } from "./api.ts";
import { type EnvVariable, readEnvFiles, redactionValues } from "./env-file.ts";
import {
	createPrivateRepository,
	type GithubCliStatus,
	githubCliNextStep,
	githubCliStatus,
} from "./github-cli.ts";
import { LOCAL_AGENT_NAMES } from "./local-agents.ts";
import type { AgentTool } from "./local-sessions/index.ts";
import { canonicalPath } from "./local-sessions/io.ts";
import { sqliteWarning } from "./local-sessions/machine.ts";
import {
	changedTrackedFiles,
	currentBranch,
	type Env,
	folderPlan,
	headCommit,
	pushCommit,
	sameCommitContent,
	snapshotFolder,
	snapshotRepository,
	tooManyFiles,
	untrackedPlan,
} from "./repo-snapshot.ts";
import {
	type BranchReport,
	type DoneReport,
	type GroupReport,
	type PlanReport,
	renderDone,
	renderNeeds,
	renderPlan,
} from "./report.ts";
import {
	buildHandoff,
	buildTranscriptArchive,
	type Candidate,
	type Discovery,
	discover,
	type Group,
	groupSessions,
	localAgent,
	planGroupRequest,
	SCOPES,
	type Scope,
	scopeSessions,
	sessionKey,
} from "./sessions.ts";
import { type ImportState, StateStore, stateDirectories } from "./state.ts";

export const DEFAULT_API = "https://ytimesy.com";

export type Io = {
	readonly env: Env;
	readonly cwd: string;
	readonly home: string;
	readonly stdout: (text: string) => void;
	readonly stderr: (text: string) => void;
	/** Ancestor agent processes (tests pin this; default walks `ps`). */
	readonly ancestors?: () => AgentTool[];
	/** Whether node:sqlite works (tests pin this; default: detected). */
	readonly sqlite?: boolean;
	readonly version: string;
};

export type ContinueOptions = {
	readonly code: string;
	readonly scope?: Scope;
	readonly planOnly: boolean;
	readonly json: boolean;
	readonly api?: string;
	readonly createRepo: readonly string[];
	readonly attach: readonly string[];
	readonly skip: readonly string[];
	readonly yesUntracked: boolean;
	readonly noUntracked: boolean;
	readonly yesPublic: boolean;
	/** --no-secrets: upload none of the .env values. */
	readonly noSecrets: boolean;
	/** --secrets A,B: upload only these .env names (the user's choice). */
	readonly secretNames: readonly string[];
	/** --cancel: stop this import (the ytimesy card stops waiting). */
	readonly cancel?: boolean;
};

/** A failure with what the agent should do next; exit code 3 means "ask the user". */
export class CliError extends Error {
	constructor(
		message: string,
		readonly next: string,
		readonly exitCode = 1,
	) {
		super(message);
	}
}

export class NeedsDecision extends Error {
	constructor(
		readonly needs: readonly string[],
		readonly nextCommand: string,
	) {
		super(needs.join("; "));
	}
}

const TOOL_NAMES: Record<AgentTool, string> = {
	...LOCAL_AGENT_NAMES,
	"cursor-agent": "Cursor CLI",
};

const PICKED_BECAUSE = {
	"caller-session": "the session running this command",
	"caller-latest": "the calling agent's newest session here",
	latest: "the newest session in this folder",
} as const;

function displayPath(folder: string, home: string) {
	return folder === home
		? "~"
		: folder.startsWith(`${home}${path.sep}`)
			? `~${folder.slice(home.length)}`
			: folder;
}

function shellWord(word: string) {
	return /^[A-Za-z0-9_@%+=:,./~-]+$/.test(word)
		? word
		: `'${word.replace(/'/g, `'\\''`)}'`;
}

// ---- decisions ---------------------------------------------------------------

type Decision =
	| { kind: "create-repo"; name: string }
	| { kind: "attach"; project: string }
	| { kind: "skip" };

/** The group an argument names: a path (absolute, ~, relative) or a unique folder name. */
function matchFolder(
	argument: string,
	groups: readonly Group[],
	io: Io,
): Group | null {
	const expanded = argument.startsWith("~")
		? path.join(io.home, argument.slice(1))
		: argument;
	const absolute = canonicalPath(path.resolve(io.cwd, expanded));
	const exact = groups.find((group) => group.folder === absolute);
	if (exact) return exact;
	const byName = groups.filter(
		(group) => path.basename(group.folder) === argument,
	);
	return byName.length === 1 ? (byName[0] as Group) : null;
}

function splitAssignment(value: string) {
	const at = value.lastIndexOf("=");
	return at <= 0
		? { folder: value, value: "" }
		: { folder: value.slice(0, at), value: value.slice(at + 1) };
}

function parseDecisions(
	options: ContinueOptions,
	groups: readonly Group[],
	io: Io,
): Map<string, Decision> {
	const decisions = new Map<string, Decision>();
	const unknown: string[] = [];
	const add = (raw: string, make: (value: string) => Decision) => {
		const { folder, value } = splitAssignment(raw);
		const group = matchFolder(folder, groups, io);
		if (!group) unknown.push(folder);
		else decisions.set(group.folder, make(value));
	};
	for (const raw of options.createRepo)
		add(raw, (name) => ({ kind: "create-repo", name }));
	for (const raw of options.attach)
		add(raw, (project) => ({ kind: "attach", project }));
	for (const raw of options.skip) add(`${raw}=`, () => ({ kind: "skip" }));
	if (unknown.length)
		throw new CliError(
			`No folder in this scope matches ${unknown.map((folder) => `"${folder}"`).join(", ")}.`,
			"Use a folder exactly as the plan prints it.",
			2,
		);
	return decisions;
}

type Resolved = {
	readonly group: Group;
	readonly entry: PlanEntry;
	readonly report: GroupReport;
	/** Where its sessions go, once decided. */
	readonly target:
		| { kind: "project"; projectId: string; projectName: string }
		/** The app reaches the repository; create-project makes its project. */
		| { kind: "register"; repository: string; projectName: string }
		/** A new private repository (made with `gh`), then its project. */
		| { kind: "create"; name: string }
		| { kind: "skip"; reason: string }
		| { kind: "undecided"; need: string };
};

function resolveGroups(
	groups: readonly Group[],
	entries: readonly PlanEntry[],
	decisions: ReadonlyMap<string, Decision>,
	state: ImportState,
	io: Io,
	/** Whether `gh` can create repositories here (asked only when needed). */
	githubCli: () => GithubCliStatus,
): Resolved[] {
	return groups.map((group, index) => {
		const entry = entries[index] as PlanEntry;
		const display = displayPath(group.folder, io.home);
		const decision = decisions.get(group.folder);
		const base = {
			folder: group.folder,
			display,
			continued: group.continued,
			sessions: group.candidates.length,
			bytes: group.bytes,
			tools: [...new Set(group.candidates.map((candidate) => candidate.tool))],
		};
		let target: Resolved["target"];
		let reportDecision: GroupReport["decision"] = null;
		let extra: Partial<GroupReport> = {};
		switch (entry.action) {
			case "import": {
				// A project an earlier run made for this repository.
				const registered = state.registered?.[group.folder];
				const projectId = entry.projectId ?? registered?.projectId ?? null;
				extra = {
					repository: entry.repository,
					visibility: entry.visibility,
					...(projectId ? { projectId } : {}),
					projectName: entry.projectName,
					newProject: entry.newProject,
				};
				if (decision?.kind === "skip" && !group.continued) {
					target = { kind: "skip", reason: "skipped" };
					reportDecision = { kind: "skip" };
				} else {
					target = projectId
						? {
								kind: "project",
								projectId,
								projectName: entry.projectName,
							}
						: {
								kind: "register",
								repository: entry.repository,
								projectName: entry.projectName,
							};
					reportDecision = {
						kind: "import",
						projectName: entry.projectName,
						newProject: entry.newProject,
					};
				}
				break;
			}
			case "grant-access": {
				extra = {
					repository: entry.repository,
					connectUrl: entry.connectUrl,
				};
				const what = `${display}: give the ytimesy GitHub app access to ${entry.repository} (${entry.connectUrl}) and re-run, or pass --skip ${shellWord(display)}`;
				if (decision?.kind === "skip" && !group.continued) {
					target = { kind: "skip", reason: "skipped" };
					reportDecision = { kind: "skip" };
				} else
					target = {
						kind: "undecided",
						need: group.continued
							? what.replace(/, or pass --skip .*$/, "")
							: what,
					};
				break;
			}
			case "no-repository": {
				const created = state.created[group.folder];
				const pending = state.githubCreated?.[group.folder];
				// gh is asked only when a repository may be created here.
				const canCreate =
					Boolean(created || pending) ||
					(decision?.kind === "create-repo" || !decision
						? githubCli().ready
						: false);
				extra = {
					reason: entry.reason,
					canCreateRepository: canCreate,
					suggestedName: entry.suggestedName,
					attachTo: entry.attachTo,
				};
				if (created) {
					target = {
						kind: "project",
						projectId: created.projectId,
						projectName: created.repository,
					};
					reportDecision = {
						kind: "create-repo",
						name: created.repository.split("/").pop() ?? "",
					};
				} else if (decision?.kind === "create-repo") {
					const name =
						pending?.repository.split("/").pop() ||
						decision.name ||
						entry.suggestedName;
					const status = githubCli();
					if (!pending && !status.ready)
						throw new CliError(
							status.reason === "missing"
								? "Creating a repository needs the GitHub CLI (gh), signed in to your GitHub account; it is not installed."
								: "Creating a repository needs the GitHub CLI (gh) signed in to your GitHub account; it is not signed in.",
							githubCliNextStep(status),
							3,
						);
					if (!/^[A-Za-z0-9_.-]{1,100}$/.test(name))
						throw new CliError(
							`"${name}" is not a valid repository name.`,
							"Use letters, digits, '.', '_' and '-' only.",
							2,
						);
					target = { kind: "create", name };
					reportDecision = { kind: "create-repo", name };
				} else if (decision?.kind === "attach") {
					const project = entry.attachTo.find(
						(candidate) =>
							candidate.id === decision.project ||
							candidate.name === decision.project,
					);
					if (!project)
						throw new CliError(
							`No project "${decision.project}" to attach ${display} to.`,
							`Use one of: ${entry.attachTo.map((candidate) => `${candidate.name} (${candidate.id})`).join(", ") || "(no projects)"}.`,
							2,
						);
					if (group.continued)
						throw new CliError(
							"The session being continued needs its own repository: its work is pushed there.",
							`Use --create-repo ${shellWord(display)}=${entry.suggestedName} instead.`,
							2,
						);
					target = {
						kind: "project",
						projectId: project.id,
						projectName: project.name,
					};
					reportDecision = {
						kind: "attach",
						projectId: project.id,
						projectName: project.name,
					};
				} else if (decision?.kind === "skip" && !group.continued) {
					target = { kind: "skip", reason: "skipped" };
					reportDecision = { kind: "skip" };
				} else {
					const options = [
						canCreate
							? `--create-repo ${shellWord(display)}=${entry.suggestedName}`
							: null,
						!group.continued && entry.attachTo.length
							? `--attach ${shellWord(display)}=<project id>`
							: null,
						group.continued ? null : `--skip ${shellWord(display)}`,
					].filter(Boolean);
					const create = canCreate
						? ""
						: ` (to create a private repository for it: ${githubCliNextStep(githubCli())})`;
					target = {
						kind: "undecided",
						need: `${display} has no GitHub repository: ${options.join(" or ") || "create one"}${create}`,
					};
				}
				break;
			}
		}
		return {
			group,
			entry,
			target,
			report: {
				...base,
				action: entry.action,
				...extra,
				decision: reportDecision,
			},
		};
	});
}

// ---- the branch --------------------------------------------------------------

function branchSlug(name: string | null) {
	const slug = (name ?? "handoff")
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/\.{2,}/g, ".")
		.replace(/^[-.]+|[-.]+$/g, "")
		.replace(/\.lock$/, "")
		.slice(0, 40)
		.replace(/[-.]+$/, "");
	return slug || "handoff";
}

function newBranchName(base: string | null) {
	const suffix = randomBytes(3).toString("hex").slice(0, 4);
	return `ytimesy/${branchSlug(base)}-${suffix}`;
}

function branchPreview(
	resolved: Resolved,
	branch: string,
	io: Io,
): BranchReport {
	const group = resolved.group;
	if (!group.git) {
		// The same rules as the push itself (snapshotFolder), nothing committed.
		const plan = folderPlan(group.folder, io.env);
		return {
			repository: null,
			branch,
			from: null,
			visibility: "new",
			trackedChanged: [],
			untrackedToPush: plan.included.map((file) => file.path),
			skipped: plan.skipped,
			wholeFolder: true,
			...(plan.tooMany ? { tooManyFiles: plan.listed } : {}),
		};
	}
	const { included, skipped } = untrackedPlan(group.folder, io.env);
	const entry = resolved.entry;
	return {
		repository: entry.action === "no-repository" ? null : entry.repository,
		branch,
		from:
			currentBranch(group.folder, io.env) ??
			headCommit(group.folder, io.env)?.slice(0, 12) ??
			null,
		visibility:
			entry.action === "import"
				? entry.visibility
				: entry.action === "no-repository"
					? "new"
					: "unknown",
		trackedChanged: changedTrackedFiles(group.folder, io.env),
		untrackedToPush: included.map((file) => file.path),
		skipped: skipped.map((file) => ({ path: file.path, reason: file.reason })),
		wholeFolder: false,
	};
}

/** Untracked files need --yes-untracked (or --no-untracked); public repositories also --yes-public. */
function untrackedNeeds(branch: BranchReport | null, options: ContinueOptions) {
	if (!branch || branch.wholeFolder || !branch.untrackedToPush.length)
		return [];
	if (options.noUntracked) return [];
	const needs: string[] = [];
	if (!options.yesUntracked)
		needs.push(
			`${branch.untrackedToPush.length} untracked file(s) would be pushed (listed in the plan): pass --yes-untracked to push them or --no-untracked to leave them out`,
		);
	if (
		(branch.visibility === "public" || branch.visibility === "unknown") &&
		!options.yesPublic
	)
		needs.push(
			`${branch.repository ?? "the repository"} is ${branch.visibility === "public" ? "public" : "of unknown visibility"}: pushing untracked files there also needs --yes-public (or --no-untracked)`,
		);
	return needs;
}

/**
 * .env values are never uploaded by default: they can hold the keys to the
 * user's own infrastructure, and the cloud machine has internet access. The
 * agent shows the names and the user picks (--secrets A,B) or --no-secrets.
 */
function secretNeeds(
	envVariables: readonly { name: string }[],
	options: ContinueOptions,
) {
	if (!envVariables.length || options.noSecrets) return [];
	const names = new Set(envVariables.map((variable) => variable.name));
	const unknown = options.secretNames.filter((name) => !names.has(name));
	if (unknown.length)
		return [
			`--secrets names not found in .env or .env.local: ${unknown.join(", ")}`,
		];
	if (options.secretNames.length) return [];
	return [
		`${names.size} variable(s) in .env files (names in the plan): ask the user which the cloud agent needs, then pass --secrets NAME,NAME or --no-secrets`,
	];
}

/** The .env variables the user chose to upload. */
export function chosenSecrets<T extends { name: string }>(
	envVariables: readonly T[],
	options: Pick<ContinueOptions, "noSecrets" | "secretNames">,
): T[] {
	if (options.noSecrets) return [];
	const chosen = new Set(options.secretNames);
	return envVariables.filter((variable) => chosen.has(variable.name));
}

// ---- the command line for the next step -------------------------------------

function nextCommand(
	options: ContinueOptions,
	scope: Scope,
	extra: string[] = [],
) {
	const words = [
		"npx -y ytimesy@latest continue --code",
		shellWord(options.code),
		"--scope",
		scope,
		...options.createRepo.flatMap((value) => [
			"--create-repo",
			shellWord(value),
		]),
		...options.attach.flatMap((value) => ["--attach", shellWord(value)]),
		...options.skip.flatMap((value) => ["--skip", shellWord(value)]),
		...(options.yesUntracked ? ["--yes-untracked"] : []),
		...(options.noUntracked ? ["--no-untracked"] : []),
		...(options.yesPublic ? ["--yes-public"] : []),
		...(options.noSecrets ? ["--no-secrets"] : []),
		...(options.secretNames.length
			? ["--secrets", shellWord(options.secretNames.join(","))]
			: []),
		...(options.api && options.api !== DEFAULT_API
			? ["--api", shellWord(options.api)]
			: []),
		...extra,
	];
	return words.join(" ");
}

// ---- the run -------------------------------------------------------------------

function totals(candidates: readonly Candidate[]) {
	return {
		sessions: candidates.length,
		bytes: candidates.reduce((sum, candidate) => sum + candidate.bytes, 0),
		folders: new Set(candidates.map((candidate) => candidate.folder)).size,
	};
}

/**
 * create-project's 409: the ytimesy app cannot see the repository yet (its
 * install covers selected repositories). The user adds it, then re-runs;
 * nothing is created twice.
 */
function projectFailure(error: unknown, what: string): never {
	if (error instanceof ApiError && error.status === 409)
		throw new CliError(
			`${what}: ${error.message}`,
			"Ask the user to add the repository to the ytimesy GitHub app (the link above), then re-run the same command; finished steps are skipped.",
			3,
		);
	return apiFailure(error, what);
}

function apiFailure(error: unknown, what: string): never {
	if (error instanceof ApiError) {
		if (error.status === 401 || error.status === 410)
			throw new CliError(
				`${what}: ${error.message}`,
				"Copy a new prompt in ytimesy and run the new command.",
			);
		if (error.status === 429)
			throw new CliError(
				`${what}: ${error.message}`,
				"Wait (the limit resets within the hour), then re-run the same command; finished steps are skipped.",
			);
		if (error.status === 0)
			throw new CliError(
				`${what}: ${error.message}`,
				process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1"
					? "The agent's sandbox blocks the network: run this command with network access (outside the sandbox), then re-run the same command."
					: "Check the network connection, then re-run the same command; finished steps are skipped.",
			);
		throw new CliError(
			`${what}: ${error.message}`,
			"Re-run the same command; finished steps are skipped. If it fails again, copy a new prompt in ytimesy.",
		);
	}
	throw error;
}

async function connect(
	options: ContinueOptions,
	store: StateStore,
	discovery: Discovery,
	io: Io,
): Promise<{ api: ImportApi; state: ImportState }> {
	const saved = store.load();
	const userAgent = `ytimesy-cli/${io.version}`;
	if (saved) {
		if (Date.parse(saved.expiresAt) <= Date.now() && !saved.finished)
			throw new CliError(
				"This import expired (its token lasts 2 hours).",
				"Copy a new prompt in ytimesy and run the new command.",
			);
		return {
			api: new ImportApi(saved.api, saved.token, userAgent),
			state: saved,
		};
	}
	if (!store.canSave())
		throw new CliError(
			`Cannot write the import's state to ${path.dirname(store.file)}; the code was not used.`,
			"Set YTIMESY_STATE_DIR to a writable folder (outside the repository), then re-run the same command.",
		);
	const base = options.api ?? io.env.YTIMESY_API ?? DEFAULT_API;
	const api = new ImportApi(base, null, userAgent);
	const caller = discovery.caller ?? discovery.continued?.candidate;
	const started = await api
		.start({
			code: options.code,
			...(caller ? { agent: localAgent(caller.tool) } : {}),
			cliVersion: io.version.slice(0, 40),
		})
		.catch((error) => apiFailure(error, "Could not start the import"));
	api.setToken(started.token);
	const state: ImportState = {
		version: 1,
		api: base,
		token: started.token,
		expiresAt: started.expiresAt,
		appUrl: started.appUrl,
		startedAt: Date.now(),
		projects: [...started.projects],
		created: {},
		uploaded: {},
	};
	store.save(state);
	return { api, state };
}

/** Text with every secret value replaced, for anything printed. */
function hideSecrets(text: string, values: readonly string[]) {
	return values.reduce(
		(result, value) => result.split(value).join("[REDACTED]"),
		text,
	);
}

function secretNames(variables: readonly EnvVariable[]) {
	const names: Record<string, string[]> = {};
	for (const variable of variables) {
		const list = names[variable.source] ?? [];
		if (!list.includes(variable.name)) list.push(variable.name);
		names[variable.source] = list;
	}
	return names;
}

function progress(io: Io, options: ContinueOptions, text: string) {
	if (options.json) io.stderr(text);
	else io.stdout(text);
}

/**
 * `--cancel`: stops the import this code started, so the card stops showing
 * it as running. A code that was never used has nothing to stop: it expires
 * on its own (or the user presses Cancel on the card).
 */
async function cancelImport(
	options: ContinueOptions,
	store: StateStore,
	io: Io,
): Promise<number> {
	const saved = store.load();
	const done = (message: string, status: string) => {
		print(io, options, { step: "cancelled", status, message }, message);
		return 0;
	};
	if (saved?.finished)
		throw new CliError(
			"This import already finished; there is nothing to cancel.",
			`Its chat: ${saved.finished.openUrl}`,
		);
	if (!saved)
		return done(
			"This code was not used, so nothing was imported. It expires 15 minutes after it was copied; Cancel on the ytimesy card stops it now.",
			"unused",
		);
	if (saved.cancelled) return done("Import cancelled.", "cancelled");
	const api = new ImportApi(
		saved.api,
		saved.token,
		`ytimesy-cli/${io.version}`,
	);
	try {
		await api.cancel();
	} catch (error) {
		// A token that no longer works means the import already stopped.
		if (!(error instanceof ApiError && error.status === 401))
			apiFailure(error, "Could not cancel the import");
	}
	saved.cancelled = true;
	store.save(saved);
	return done("Import cancelled. Nothing more is uploaded.", "cancelled");
}

export async function runContinue(
	options: ContinueOptions,
	io: Io,
): Promise<number> {
	const store = new StateStore(stateDirectories(io.env), options.code);
	if (options.cancel) return cancelImport(options, store, io);
	const saved = store.load();
	const finished = saved?.finished?.report as DoneReport | undefined;
	if (finished) {
		print(io, options, finished, renderDone(finished));
		return 0;
	}
	if (saved?.cancelled)
		throw new CliError(
			"This import was cancelled.",
			"Copy a new prompt in ytimesy and run the new command.",
		);

	const discovery = discover({
		cwd: io.cwd,
		home: io.home,
		env: io.env,
		...(io.ancestors ? { ancestors: io.ancestors } : {}),
		...(io.sqlite === undefined ? {} : { sqlite: io.sqlite }),
	});
	// Not a silent skip: say which agents' sessions this Node cannot read.
	const nodeWarning = sqliteWarning(discovery.needsNewerNode);
	if (nodeWarning) io.stderr(nodeWarning);
	const continued = discovery.continued;
	if (!continued)
		throw new CliError(
			`No coding-agent session was found for ${displayPath(discovery.folder, io.home)}.`,
			"Run this command from the folder the session works in (its repository).",
		);
	const { api, state } = await connect(options, store, discovery, io);
	const scope = options.scope ?? "session";
	const candidates = scopeSessions(discovery, scope);
	const { groups, droppedGroups } = groupSessions(candidates, discovery.folder);
	const planned = await api
		.plan(groups.map(planGroupRequest))
		.catch((error) => apiFailure(error, "Could not plan the import"));
	if (planned.groups.length !== groups.length)
		throw new CliError(
			"The server's plan does not match the folders sent.",
			"Re-run the same command.",
		);
	const decisions = parseDecisions(options, groups, io);
	let githubCli: GithubCliStatus | undefined;
	const resolved = resolveGroups(
		groups,
		planned.groups,
		decisions,
		state,
		io,
		() => {
			githubCli ??= githubCliStatus(io.env);
			return githubCli;
		},
	);
	const main = resolved.find((item) => item.group.continued) as Resolved;
	state.branchName ??= newBranchName(
		main.group.git ? currentBranch(main.group.folder, io.env) : null,
	);
	store.save(state);
	const branch = branchPreview(main, state.branchName, io);
	const envVariables = readEnvFiles(main.group.folder);
	const needs = [
		...resolved.flatMap((item) =>
			item.target.kind === "undecided" ? [item.target.need] : [],
		),
		...(branch.tooManyFiles
			? [tooManyFiles(main.report.display, branch.tooManyFiles)]
			: []),
		...untrackedNeeds(branch, options),
		...secretNeeds(envVariables, options),
	];

	if (options.planOnly || !options.scope) {
		const continuedCandidate = continued.candidate;
		const hide = redactionValues([
			...envVariables,
			...resolved.flatMap((item) =>
				item.group.continued ? [] : readEnvFiles(item.group.folder),
			),
		]);
		const title = continuedCandidate.title
			? hideSecrets(continuedCandidate.title, hide)
			: null;
		const report: PlanReport = {
			step: "plan",
			agent: discovery.caller
				? {
						tool: discovery.caller.tool,
						name: TOOL_NAMES[discovery.caller.tool],
					}
				: null,
			session: {
				tool: TOOL_NAMES[continuedCandidate.tool],
				id: continuedCandidate.id,
				title,
				messages: continuedCandidate.messages,
				bytes: continuedCandidate.bytes,
				folder: displayPath(main.group.folder, io.home),
				pickedBecause: PICKED_BECAUSE[continued.reason],
			},
			scope,
			scopes: Object.fromEntries(
				SCOPES.map((name) => [
					name,
					totals(scopeSessions(discovery, name, false)),
				]),
			),
			groups: resolved.map((item) => item.report),
			droppedGroups,
			branch,
			secrets: secretNames(envVariables),
			needs,
			next: nextCommand(
				options,
				scope,
				branch.untrackedToPush.length &&
					!options.yesUntracked &&
					!options.noUntracked &&
					!branch.wholeFolder
					? ["--yes-untracked"]
					: [],
			),
		};
		print(io, options, report, renderPlan(report));
		return 0;
	}

	if (needs.length) {
		const report = {
			step: "needs-decision" as const,
			needs,
			next: nextCommand(options, scope),
		};
		print(io, options, report, renderNeeds(report));
		return 3;
	}

	return execute({
		options,
		io,
		api,
		state,
		store,
		resolved,
		main,
		branchName: state.branchName,
		envVariables,
		continued: continued.candidate,
	});
}

/** Finish takes at most this many pushed and skipped paths (the chat's details). */
export const FINISH_LISTED_FILES = 200;

/** The pushed and skipped paths finish takes: unique, bounded, paths only. */
export function finishPaths(
	pushed: readonly string[],
	skipped: readonly { path: string }[],
) {
	const bounded = (paths: readonly string[]) =>
		[...new Set(paths)]
			.filter((file) => file.length > 0 && file.length <= 1024)
			.slice(0, FINISH_LISTED_FILES);
	return {
		pushedPaths: bounded(pushed),
		skippedPaths: bounded(skipped.map((file) => file.path)),
	};
}

function print(io: Io, options: ContinueOptions, data: unknown, text: string) {
	io.stdout(options.json ? JSON.stringify(data, null, 2) : text);
}

/** Remote URLs to try for a new repository: the scheme the user's origin uses first. */
function pushUrls(created: ImportState["created"][string], preferSsh: boolean) {
	return preferSsh
		? [created.sshUrl, created.cloneUrl]
		: [created.cloneUrl, created.sshUrl];
}

function pushToNewRepository(input: {
	created: ImportState["created"][string];
	cwd: string;
	env: Env;
	sha: string;
	branch: string;
	preferSsh: boolean;
	lease?: string;
}) {
	let lastError: unknown;
	const urls = input.created.pushedTo
		? [input.created.pushedTo]
		: pushUrls(input.created, input.preferSsh);
	for (const url of urls) {
		try {
			pushCommit({
				cwd: input.cwd,
				env: input.env,
				remote: url,
				sha: input.sha,
				branch: input.branch,
				...(input.lease ? { lease: input.lease } : {}),
			});
			return url;
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError;
}

async function execute(input: {
	options: ContinueOptions;
	io: Io;
	api: ImportApi;
	state: ImportState;
	store: StateStore;
	resolved: Resolved[];
	main: Resolved;
	branchName: string;
	envVariables: EnvVariable[];
	continued: Candidate;
}): Promise<number> {
	const { options, io, api, state, store, resolved, main } = input;
	const say = (text: string) => progress(io, options, text);
	const env = io.env;

	// Every folder's .env values are redacted from what is uploaded.
	const redactValues = redactionValues([
		...input.envVariables,
		...resolved.flatMap((item) =>
			item.group.continued ? [] : readEnvFiles(item.group.folder),
		),
	]);

	// 1. Projects: for repositories the app reaches without one, and for new
	// repositories, which `gh` creates with the user's own GitHub login.
	const createdRepositories: DoneReport["createdRepositories"][number][] = [];
	const setTarget = (item: Resolved, target: Resolved["target"]) => {
		(item as { target: Resolved["target"] }).target = target;
	};
	for (const item of resolved) {
		if (item.target.kind !== "register") continue;
		const repository = item.target.repository;
		say(`Adding ${repository} to ytimesy as a project…`);
		const registered = await api
			.createProject({ folder: item.group.folder, repository })
			.catch((error) =>
				projectFailure(error, `Could not add ${repository} as a project`),
			);
		state.registered = {
			...state.registered,
			[item.group.folder]: {
				projectId: registered.projectId,
				repository: registered.repository,
			},
		};
		store.save(state);
		setTarget(item, {
			kind: "project",
			projectId: registered.projectId,
			projectName: item.target.projectName,
		});
	}
	for (const item of resolved) {
		if (item.target.kind !== "create") continue;
		const folder = item.group.folder;
		let repository = state.githubCreated?.[folder];
		if (!repository) {
			say(
				`Creating private repository ${item.target.name} for ${item.report.display} with your GitHub login (gh)…`,
			);
			let made: ReturnType<typeof createPrivateRepository>;
			try {
				made = createPrivateRepository(item.target.name, env);
			} catch (error) {
				throw new CliError(
					(error as Error).message,
					"Pick another name with --create-repo <folder>=<name>, or create the repository at https://github.com/new and make it this folder's origin remote.",
				);
			}
			repository = {
				repository: made.fullName,
				defaultBranch: made.defaultBranch,
				cloneUrl: made.cloneUrl,
				sshUrl: made.sshUrl,
			};
			state.githubCreated = { ...state.githubCreated, [folder]: repository };
			store.save(state);
		}
		const created = await api
			.createProject({ folder, repository: repository.repository })
			.catch((error) =>
				projectFailure(
					error,
					`Created ${repository.repository}, but ytimesy could not add it as a project`,
				),
			);
		state.created[folder] = {
			projectId: created.projectId,
			repository: created.repository,
			defaultBranch: repository.defaultBranch,
			cloneUrl: repository.cloneUrl,
			sshUrl: repository.sshUrl,
		};
		store.save(state);
		setTarget(item, {
			kind: "project",
			projectId: created.projectId,
			projectName: created.repository,
		});
		createdRepositories.push({
			folder: item.report.display,
			repository: created.repository,
		});
	}
	for (const item of resolved) {
		const created = state.created[item.group.folder];
		if (
			created &&
			!createdRepositories.some(
				(entry) => entry.repository === created.repository,
			)
		)
			createdRepositories.push({
				folder: item.report.display,
				repository: created.repository,
			});
	}

	const preferSsh = /^(?:ssh:\/\/|git@)/.test(main.group.git?.remoteUrl ?? "");
	const pushed: string[] = [];
	const skipped: { path: string; reason: string }[] = [];
	let branchSha: string;
	let repository: string | null = null;

	// 2. Push the folders of new repositories (the continued one gets its branch too).
	for (const item of resolved) {
		const created = state.created[item.group.folder];
		if (!created || item.target.kind !== "project") continue;
		if (item.group.continued) continue;
		if (created.pushedSha) continue;
		try {
			const sha = item.group.git ? headCommit(item.group.folder, env) : null;
			if (item.group.git && !sha) {
				say(
					`${item.report.display} has no commits; ${created.repository} stays empty.`,
				);
				continue;
			}
			if (sha) {
				say(
					`Pushing ${item.report.display} (committed work) to ${created.repository}…`,
				);
				created.pushedTo = pushToNewRepository({
					created,
					cwd: item.group.folder,
					env,
					sha,
					branch: created.defaultBranch,
					preferSsh,
				});
				created.pushedSha = sha;
			} else {
				say(`Pushing ${item.report.display} to ${created.repository}…`);
				const snapshot = snapshotFolder({
					folder: item.group.folder,
					env,
					message: "Initial import from ytimesy",
				});
				try {
					created.pushedTo = pushToNewRepository({
						created,
						cwd: item.group.folder,
						env: snapshot.env,
						sha: snapshot.sha,
						branch: created.defaultBranch,
						preferSsh,
					});
					created.pushedSha = snapshot.sha;
				} finally {
					fs.rmSync(snapshot.gitDir, { recursive: true, force: true });
				}
			}
			store.save(state);
		} catch (error) {
			throw new CliError(
				`Could not push ${item.report.display} to ${created.repository}: ${(error as Error).message}`,
				`Check that you can push to github.com/${created.repository} from this terminal, then re-run the same command; finished steps are skipped.`,
			);
		}
	}

	// 3. The continued work, on its ytimesy/ branch.
	const branch = input.branchName;
	const message = `Work in progress from a local ${TOOL_NAMES[main.group.candidates[0]?.tool ?? "claude"] ?? "agent"} session, continued in ytimesy`;
	try {
		const created = state.created[main.group.folder];
		if (created) {
			repository = created.repository;
			if (main.group.git) {
				const snapshot = snapshotRepository({
					root: main.group.folder,
					env,
					message,
					includeUntracked: !options.noUntracked,
				});
				pushed.push(...snapshot.trackedChanged, ...snapshot.untrackedPushed);
				skipped.push(
					...snapshot.skipped.map((file) => ({
						path: file.path,
						reason: file.reason,
					})),
				);
				if (options.noUntracked)
					skipped.push(
						...untrackedPlan(main.group.folder, env).included.map((file) => ({
							path: file.path,
							reason: "untracked; --no-untracked",
						})),
					);
				const head = headCommit(main.group.folder, env);
				if (!created.pushedSha) {
					say(`Pushing ${main.report.display} to ${created.repository}…`);
					created.pushedTo = pushToNewRepository({
						created,
						cwd: main.group.folder,
						env,
						sha: head ?? snapshot.sha,
						branch: created.defaultBranch,
						preferSsh,
					});
					created.pushedSha = head ?? snapshot.sha;
					store.save(state);
				}
				branchSha =
					state.pushed &&
					sameCommitContent(
						main.group.folder,
						env,
						state.pushed.sha,
						snapshot.sha,
					)
						? state.pushed.sha
						: snapshot.sha;
				if (state.pushed?.sha !== branchSha) {
					say(`Pushing ${branch} to ${created.repository}…`);
					pushToNewRepository({
						created,
						cwd: main.group.folder,
						env,
						sha: branchSha,
						branch,
						preferSsh,
						...(state.pushed ? { lease: state.pushed.sha } : {}),
					});
				}
			} else {
				const snapshot = snapshotFolder({
					folder: main.group.folder,
					env,
					message,
				});
				try {
					pushed.push(...snapshot.pushed);
					skipped.push(
						...snapshot.skipped.map((file) => ({
							path: file.path,
							reason: file.reason,
						})),
					);
					branchSha = created.pushedSha ?? snapshot.sha;
					if (!created.pushedSha) {
						say(`Pushing ${main.report.display} to ${created.repository}…`);
						created.pushedTo = pushToNewRepository({
							created,
							cwd: main.group.folder,
							env: snapshot.env,
							sha: snapshot.sha,
							branch: created.defaultBranch,
							preferSsh,
						});
						created.pushedSha = snapshot.sha;
						store.save(state);
					}
					if (state.pushed?.sha !== branchSha) {
						say(`Pushing ${branch} to ${created.repository}…`);
						pushToNewRepository({
							created,
							cwd: main.group.folder,
							env: snapshot.env,
							sha: branchSha,
							branch,
							preferSsh,
						});
					}
				} finally {
					fs.rmSync(snapshot.gitDir, { recursive: true, force: true });
				}
			}
		} else {
			if (main.entry.action !== "import")
				throw new CliError(
					"The continued folder has no project.",
					"Re-run the plan.",
				);
			repository = main.entry.repository;
			const snapshot = snapshotRepository({
				root: main.group.folder,
				env,
				message,
				includeUntracked: !options.noUntracked,
			});
			pushed.push(...snapshot.trackedChanged, ...snapshot.untrackedPushed);
			skipped.push(
				...snapshot.skipped.map((file) => ({
					path: file.path,
					reason: file.reason,
				})),
			);
			if (options.noUntracked)
				skipped.push(
					...untrackedPlan(main.group.folder, env).included.map((file) => ({
						path: file.path,
						reason: "untracked; --no-untracked",
					})),
				);
			branchSha =
				state.pushed &&
				sameCommitContent(
					main.group.folder,
					env,
					state.pushed.sha,
					snapshot.sha,
				)
					? state.pushed.sha
					: snapshot.sha;
			if (state.pushed?.sha !== branchSha) {
				say(
					`Pushing ${branch} to ${repository} (your checkout is not touched)…`,
				);
				pushCommit({
					cwd: main.group.folder,
					env,
					remote: "origin",
					sha: branchSha,
					branch,
					...(state.pushed ? { lease: state.pushed.sha } : {}),
				});
			}
		}
		state.pushed = { repository: repository ?? "", branch, sha: branchSha };
		store.save(state);
	} catch (error) {
		if (error instanceof CliError) throw error;
		throw new CliError(
			`Could not push ${branch}: ${(error as Error).message}`,
			`Check that \`git push\` works from ${main.report.display} in this terminal (your Git credentials are used), then re-run the same command; finished steps are skipped.`,
		);
	}

	const mainProject =
		main.target.kind === "project" ? main.target.projectId : null;
	if (!mainProject)
		throw new CliError(
			"The continued folder has no project.",
			"Re-run the plan.",
		);

	// 4. Secrets from .env and .env.local.
	const variables = chosenSecrets(input.envVariables, input.options).filter(
		(variable) => variable.name.length <= 128 && variable.value.length <= 8192,
	);
	const secretList = [...new Set(variables.map((variable) => variable.name))];
	if (
		variables.length &&
		!(
			state.secrets?.projectId === mainProject &&
			state.secrets.names.join() === secretList.join()
		)
	) {
		say(
			`Saving ${secretList.length} secret name(s) from .env files to the project…`,
		);
		await api
			.secrets({ projectId: mainProject, variables: variables.slice(0, 200) })
			.catch((error) => apiFailure(error, "Could not save the .env secrets"));
		state.secrets = { projectId: mainProject, names: secretList };
		store.save(state);
	}

	// 5. Sessions: handoff, then the full transcript.
	const uploads = resolved.flatMap((item) =>
		item.target.kind === "project"
			? item.group.candidates.map((candidate) => ({
					candidate,
					projectId: (item.target as { projectId: string }).projectId,
				}))
			: [],
	);
	const failed: { session: string; error: string }[] = [];
	const failedByKey = new Map<string, string>();
	const transcriptsMissing: { session: string; reason: string }[] = [];
	let uploaded = 0;
	let alreadyUploaded = 0;
	for (const [index, { candidate, projectId }] of uploads.entries()) {
		const key = `${projectId}:${sessionKey(candidate)}`;
		const label = `${TOOL_NAMES[candidate.tool]} ${candidate.title ? `"${hideSecrets(candidate.title, redactValues).slice(0, 60)}"` : candidate.id}`;
		const previous = state.uploaded[key];
		if (previous?.transcript && previous.updatedAt === candidate.updatedAt) {
			alreadyUploaded++;
			continue;
		}
		say(`Session ${index + 1}/${uploads.length}: ${label}`);
		try {
			const handoff = buildHandoff(candidate, {
				home: io.home,
				redactValues,
				importStartedAt: state.startedAt,
			});
			const saved = await api.session({
				projectId,
				handoff,
				total: uploads.length,
			});
			state.uploaded[key] = {
				importedSessionId: saved.importedSessionId,
				transcript: false,
				updatedAt: candidate.updatedAt,
			};
			store.save(state);
			const archive = buildTranscriptArchive(candidate, {
				home: io.home,
				redactValues,
			});
			if (archive) {
				await api.transcript(saved.transcriptUpload, archive.archive);
				if (archive.imagesDropped)
					transcriptsMissing.push({
						session: label,
						reason: "images left out (over 25 MB)",
					});
			} else
				transcriptsMissing.push({
					session: label,
					reason: "over 25 MB compressed",
				});
			state.uploaded[key] = {
				importedSessionId: saved.importedSessionId,
				transcript: true,
				updatedAt: candidate.updatedAt,
			};
			store.save(state);
			uploaded++;
		} catch (error) {
			if (error instanceof ApiError && [401, 410, 429].includes(error.status))
				apiFailure(error, "Upload stopped");
			failed.push({ session: label, error: (error as Error).message });
			failedByKey.set(key, (error as Error).message);
		}
	}
	// 6. Finish: the chat on the pushed branch.
	const continuedSession = input.continued;
	if (
		!state.uploaded[`${mainProject}:${sessionKey(continuedSession)}`]
			?.transcript
	) {
		const reason = failedByKey.get(
			`${mainProject}:${sessionKey(continuedSession)}`,
		);
		throw new CliError(
			`The session being continued was not uploaded${reason ? ` (${reason})` : ""}.`,
			"Re-run the same command; finished steps are skipped.",
		);
	}
	say("Opening the chat in ytimesy…");
	const done = await api
		.finish({
			projectId: mainProject,
			continue: {
				tool: localAgent(continuedSession.tool),
				sessionId: continuedSession.id,
			},
			branch,
			...(repository ? { repository } : {}),
			pushedFiles: pushed.length,
			skippedFiles: skipped.length,
			...finishPaths(pushed, skipped),
		})
		.catch((error) => apiFailure(error, "Could not open the chat"));
	const report: DoneReport = {
		step: "done",
		openUrl: done.openUrl,
		repository,
		branch,
		pushed,
		skipped,
		sessions: { uploaded, alreadyUploaded, failed, transcriptsMissing },
		secrets: state.secrets?.names ?? [],
		createdRepositories,
		skippedFolders: resolved.flatMap((item) =>
			item.target.kind === "skip"
				? [{ folder: item.report.display, reason: "skipped" }]
				: [],
		),
	};
	state.finished = {
		openUrl: done.openUrl,
		projectId: done.projectId,
		sessionId: done.sessionId,
		report,
	};
	store.save(state);
	print(io, options, report, renderDone(report));
	return 0;
}
