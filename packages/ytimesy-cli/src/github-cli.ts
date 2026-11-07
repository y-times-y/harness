import { execFileSync } from "node:child_process";
import type { Env } from "./repo-snapshot.ts";

/**
 * New repositories are made with the user's own GitHub login through the
 * GitHub CLI (`gh`), never with a ytimesy token: ytimesy's GitHub app has no
 * permission to create repositories. Without `gh` (or signed out), the CLI
 * says how to create the repository another way.
 */

export type GithubCliStatus =
	| { readonly ready: true }
	| { readonly ready: false; readonly reason: "missing" | "signed-out" };

export type CreatedRepository = {
	readonly fullName: string;
	readonly defaultBranch: string;
	readonly cloneUrl: string;
	readonly sshUrl: string;
};

export class GithubCliError extends Error {}

function gh(args: readonly string[], env: Env) {
	return execFileSync("gh", args, {
		env: {
			...env,
			GH_PROMPT_DISABLED: "1",
			NO_COLOR: "1",
		} as NodeJS.ProcessEnv,
		encoding: "utf8",
		timeout: 60_000,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

/** Whether `gh` is installed and signed in to github.com. */
export function githubCliStatus(env: Env): GithubCliStatus {
	try {
		gh(["--version"], env);
	} catch {
		return { ready: false, reason: "missing" };
	}
	try {
		gh(["auth", "status", "--hostname", "github.com"], env);
		return { ready: true };
	} catch {
		return { ready: false, reason: "signed-out" };
	}
}

/** The next step when `gh` cannot create the repository. */
export function githubCliNextStep(status: GithubCliStatus) {
	const otherwise =
		"or create the repository at https://github.com/new, make it this folder's origin remote (git init first if needed) and re-run without --create-repo";
	return status.ready
		? ""
		: status.reason === "missing"
			? `Install the GitHub CLI (https://cli.github.com) and run \`gh auth login\`, then re-run the same command; ${otherwise}.`
			: `Run \`gh auth login\` to sign in to GitHub, then re-run the same command; ${otherwise}.`;
}

/** A new private repository on the signed-in user's account, empty (no commit). */
export function createPrivateRepository(
	name: string,
	env: Env,
): CreatedRepository {
	let output: string;
	try {
		output = gh(
			[
				"api",
				"--method",
				"POST",
				"user/repos",
				"-f",
				`name=${name}`,
				"-F",
				"private=true",
			],
			env,
		);
	} catch (error) {
		const failure = error as { stderr?: string | Buffer; stdout?: string };
		const text = `${String(failure.stdout ?? "")} ${String(failure.stderr ?? "")}`;
		if (/name already exists/i.test(text))
			throw new GithubCliError(
				`A repository named ${name} already exists on your GitHub account.`,
			);
		throw new GithubCliError(
			`gh could not create ${name}: ${text.trim().split("\n").slice(-2).join(" ") || (error as Error).message}`,
		);
	}
	const created = JSON.parse(output) as {
		full_name?: string;
		default_branch?: string | null;
		clone_url?: string;
		ssh_url?: string;
	};
	if (!created.full_name)
		throw new GithubCliError(`gh did not return the new repository ${name}.`);
	return {
		fullName: created.full_name,
		defaultBranch: created.default_branch || "main",
		cloneUrl:
			created.clone_url || `https://github.com/${created.full_name}.git`,
		sshUrl: created.ssh_url || `git@github.com:${created.full_name}.git`,
	};
}
