import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PlanProject } from "./api.ts";

/**
 * What one import has done so far, so re-running the same command resumes:
 * the token from start (the code works once), created projects, the pushed
 * branch and the sessions already uploaded. Kept in ~/.ytimesy/cli/imports,
 * readable only by the user, one file per code.
 */

export type ImportState = {
	version: 1;
	api: string;
	token: string;
	expiresAt: string;
	appUrl: string;
	/** When the first run started (ms); later turns are about the import itself. */
	startedAt: number;
	projects: PlanProject[];
	/** The handoff branch for the continued repository, fixed on the first run. */
	branchName?: string;
	/**
	 * Folder → the repository `gh` created for it, before ytimesy made it a
	 * project (the app may not see it yet); a re-run does not create it again.
	 */
	githubCreated?: Record<
		string,
		{
			repository: string;
			defaultBranch: string;
			cloneUrl: string;
			sshUrl: string;
		}
	>;
	/** Folder → the project made for its existing repository (the plan's new project). */
	registered?: Record<string, { projectId: string; repository: string }>;
	/** Folder → the new repository and its project (create-project after `gh`). */
	created: Record<
		string,
		{
			projectId: string;
			repository: string;
			defaultBranch: string;
			cloneUrl: string;
			sshUrl: string;
			/** The commit pushed to the default branch. */
			pushedSha?: string;
			/** The remote URL that worked. */
			pushedTo?: string;
		}
	>;
	/** The handoff branch as pushed. */
	pushed?: { repository: string; branch: string; sha: string };
	/** `${projectId}:${tool}:${sessionId}` → uploaded. */
	uploaded: Record<
		string,
		{ importedSessionId: string; transcript: boolean; updatedAt: number }
	>;
	secrets?: { projectId: string; names: string[] };
	/** Set by --cancel: the server stopped this import. */
	cancelled?: boolean;
	/** The finished import; a re-run prints its report again. */
	finished?: {
		openUrl: string;
		projectId: string;
		sessionId: string;
		report?: unknown;
	};
};

/** The code as the server normalizes it: upper case, no spaces or dashes, no YTM prefix. */
export function codeKey(code: string) {
	const compact = code.toUpperCase().replace(/[\s-]/g, "");
	const body = compact.startsWith("YTM") ? compact.slice(3) : compact;
	return createHash("sha256").update(`ytimesy-cli\n${body}`).digest("hex");
}

/**
 * Where import state may live, in order: YTIMESY_STATE_DIR, ~/.ytimesy, and
 * the temp directory (an agent sandbox may only allow writes there).
 */
export function stateDirectories(env: Record<string, string | undefined>) {
	if (env.YTIMESY_STATE_DIR) return [env.YTIMESY_STATE_DIR];
	const user = (() => {
		try {
			return os.userInfo().username;
		} catch {
			return "user";
		}
	})();
	return [
		path.join(env.HOME || os.homedir(), ".ytimesy", "cli", "imports"),
		path.join(os.tmpdir(), `ytimesy-cli-${user}`, "imports"),
	];
}

function writable(directory: string) {
	try {
		fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
		const probe = path.join(directory, `.probe-${process.pid}`);
		fs.writeFileSync(probe, "");
		fs.rmSync(probe);
		return true;
	} catch {
		return false;
	}
}

export class StateStore {
	readonly file: string;

	/** The existing state file for this code, else one in the first writable directory. */
	constructor(directories: readonly string[], code: string) {
		const name = `${codeKey(code)}.json`;
		const existing = directories
			.map((directory) => path.join(directory, name))
			.find((file) => fs.existsSync(file));
		const directory =
			directories.find((candidate) => writable(candidate)) ?? directories[0];
		this.file = existing ?? path.join(directory as string, name);
	}

	load(): ImportState | null {
		try {
			const state = JSON.parse(fs.readFileSync(this.file, "utf8"));
			return state?.version === 1 ? (state as ImportState) : null;
		} catch {
			return null;
		}
	}

	/** Throws when the state cannot be written; nothing irreversible may run before that is known. */
	save(state: ImportState) {
		fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
		const temporary = `${this.file}.${process.pid}.tmp`;
		fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
			mode: 0o600,
		});
		fs.renameSync(temporary, this.file);
	}

	/** Whether save will work, checked before the one-time code is spent. */
	canSave() {
		return writable(path.dirname(this.file));
	}
}
