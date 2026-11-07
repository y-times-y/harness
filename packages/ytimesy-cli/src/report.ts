/**
 * What the CLI prints: a plan the agent shows the user, the decisions still
 * needed, and the final "Done — open <url>" with the files pushed and
 * skipped. Each report is plain data; --json prints it as is.
 */

export type Totals = {
	readonly sessions: number;
	readonly bytes: number;
	readonly folders: number;
};

export type GroupReport = {
	readonly folder: string;
	readonly display: string;
	readonly continued: boolean;
	readonly sessions: number;
	readonly bytes: number;
	readonly tools: readonly string[];
	readonly action: "import" | "grant-access" | "no-repository";
	readonly repository?: string;
	readonly visibility?: "public" | "private" | "unknown";
	readonly projectId?: string;
	readonly projectName?: string;
	/** Import: no project holds the repository yet; this run makes one. */
	readonly newProject?: boolean;
	readonly connectUrl?: string;
	readonly reason?: "no-git" | "no-remote" | "other-host";
	/** Whether this machine's GitHub CLI (gh) can create the repository. */
	readonly canCreateRepository?: boolean;
	readonly suggestedName?: string;
	readonly attachTo?: readonly { id: string; name: string }[];
	/** What this run does with the folder, or null when the user must decide. */
	readonly decision:
		| {
				readonly kind: "import";
				readonly projectName: string;
				readonly newProject?: boolean;
		  }
		| { readonly kind: "create-repo"; readonly name: string }
		| {
				readonly kind: "attach";
				readonly projectId: string;
				readonly projectName: string;
		  }
		| { readonly kind: "skip" }
		| null;
};

export type BranchReport = {
	readonly repository: string | null;
	readonly branch: string;
	readonly from: string | null;
	readonly visibility: "public" | "private" | "unknown" | "new";
	readonly trackedChanged: readonly string[];
	readonly untrackedToPush: readonly string[];
	readonly skipped: readonly { path: string; reason: string }[];
	/** Not a Git repository: the folder becomes the first commit. */
	readonly wholeFolder: boolean;
	/** The folder has this many files, over the limit: nothing would be pushed. */
	readonly tooManyFiles?: number;
};

export type PlanReport = {
	readonly step: "plan";
	readonly agent: { readonly tool: string; readonly name: string } | null;
	readonly session: {
		readonly tool: string;
		readonly id: string;
		readonly title: string | null;
		readonly messages: number;
		readonly bytes: number;
		readonly folder: string;
		readonly pickedBecause: string;
	};
	readonly scope: string;
	readonly scopes: Readonly<Record<string, Totals>>;
	readonly groups: readonly GroupReport[];
	readonly droppedGroups: number;
	readonly branch: BranchReport | null;
	readonly secrets: Readonly<Record<string, readonly string[]>>;
	/** Decisions or confirmations needed before the import can run. */
	readonly needs: readonly string[];
	readonly next: string;
};

export type DoneReport = {
	readonly step: "done";
	readonly openUrl: string;
	readonly repository: string | null;
	readonly branch: string;
	readonly pushed: readonly string[];
	readonly skipped: readonly { path: string; reason: string }[];
	readonly sessions: {
		readonly uploaded: number;
		readonly alreadyUploaded: number;
		readonly failed: readonly { session: string; error: string }[];
		readonly transcriptsMissing: readonly { session: string; reason: string }[];
	};
	readonly secrets: readonly string[];
	readonly createdRepositories: readonly {
		folder: string;
		repository: string;
	}[];
	readonly skippedFolders: readonly { folder: string; reason: string }[];
};

export type NeedsReport = {
	readonly step: "needs-decision";
	readonly needs: readonly string[];
	readonly next: string;
};

export type ErrorReport = {
	readonly step: "error";
	readonly error: string;
	readonly next: string;
};

export function megabytes(bytes: number) {
	if (bytes <= 0) return "0 MB";
	const value = bytes / 1_000_000;
	return value < 0.1 ? "<0.1 MB" : `${value.toFixed(1)} MB`;
}

const plural = (count: number, word: string) =>
	`${count} ${word}${count === 1 ? "" : "s"}`;

function listLines(items: readonly string[], limit = 30) {
	const lines = items.slice(0, limit).map((item) => `    ${item}`);
	if (items.length > limit)
		lines.push(`    … and ${items.length - limit} more`);
	return lines;
}

function groupAction(group: GroupReport) {
	const decision = group.decision;
	switch (group.action) {
		case "import":
			if (decision?.kind === "skip") return "skip";
			return group.newProject && !group.projectId
				? `import (new project "${group.projectName}")`
				: `import into project "${group.projectName}"`;
		case "grant-access":
			return decision?.kind === "skip"
				? "skip"
				: `give the ytimesy GitHub app access to ${group.repository} first: ${group.connectUrl}`;
		case "no-repository": {
			if (decision?.kind === "create-repo")
				return `create private repository "${decision.name}" (with your gh login) and import`;
			if (decision?.kind === "attach")
				return `import into project "${decision.projectName}"`;
			if (decision?.kind === "skip") return "skip";
			const why =
				group.reason === "no-git"
					? "not a Git repository"
					: group.reason === "other-host"
						? "remote is not on GitHub"
						: "no GitHub remote";
			return `${why}: create a private repository, attach to a project, or skip`;
		}
	}
}

function repositoryLabel(group: GroupReport) {
	if (!group.repository) return "";
	return group.visibility && group.visibility !== "unknown"
		? `${group.repository} (${group.visibility})`
		: group.repository;
}

export function renderPlan(report: PlanReport) {
	const lines: string[] = [];
	const session = report.session;
	lines.push(
		`ytimesy import plan${report.agent ? ` (called from ${report.agent.name})` : ""}`,
		"",
		`This session: ${session.title ? `"${session.title}"` : "(untitled)"} · ${session.tool} · ${plural(session.messages, "message")} · ${megabytes(session.bytes)}`,
		`  folder ${session.folder} (${session.pickedBecause})`,
		"",
		"Scopes (pass one with --scope):",
	);
	for (const [name, totals] of Object.entries(report.scopes))
		lines.push(
			`  ${name.padEnd(8)} ${plural(totals.sessions, "session")}${totals.sessions > 500 ? " (the newest 500 are imported)" : ""}, ${megabytes(totals.bytes)} in ${plural(totals.folders, "folder")}${name === "session" ? "  (default)" : ""}${name === report.scope ? "  <- shown below" : ""}`,
		);
	lines.push("", `Folders in scope "${report.scope}":`);
	for (const group of report.groups) {
		const repository = repositoryLabel(group);
		lines.push(
			`  ${group.display}${group.continued ? " (this session)" : ""}${repository ? ` · ${repository}` : ""} · ${plural(group.sessions, "session")}, ${megabytes(group.bytes)}`,
			`    -> ${groupAction(group)}`,
		);
		if (group.action === "no-repository" && !group.decision) {
			const options = [
				group.canCreateRepository
					? `--create-repo ${group.display}=${group.suggestedName}`
					: null,
				group.attachTo?.length
					? `--attach ${group.display}=<project id>`
					: null,
				group.continued ? null : `--skip ${group.display}`,
			].filter(Boolean);
			lines.push(`    options: ${options.join("  |  ")}`);
			if (group.attachTo?.length)
				lines.push(
					`    projects: ${group.attachTo
						.slice(0, 10)
						.map((project) => `${project.name} (${project.id})`)
						.join(", ")}`,
				);
		}
	}
	if (report.droppedGroups)
		lines.push(
			`  (${plural(report.droppedGroups, "older folder")} left out: at most 200 per import)`,
		);
	if (report.branch) {
		const branch = report.branch;
		lines.push(
			"",
			`Branch ${branch.branch}${branch.repository ? ` on ${branch.repository}` : ""}${branch.from ? `, from ${branch.from}` : ""} (your checkout is not touched):`,
		);
		if (branch.wholeFolder && branch.tooManyFiles)
			lines.push(
				`  the folder has ${branch.tooManyFiles} files, more than can be pushed: add a .gitignore for build output and dependencies`,
			);
		else if (branch.wholeFolder) {
			lines.push(
				`  the folder becomes the repository's first commit: ${plural(branch.untrackedToPush.length, "file")}`,
			);
			lines.push(...listLines(branch.untrackedToPush));
		} else {
			lines.push(
				`  ${plural(branch.trackedChanged.length, "uncommitted tracked change")}`,
			);
			if (branch.trackedChanged.length)
				lines.push(...listLines(branch.trackedChanged, 15));
			lines.push(
				`  ${plural(branch.untrackedToPush.length, "untracked file")} to push${branch.untrackedToPush.length ? " (needs --yes-untracked)" : ""}`,
			);
			lines.push(...listLines(branch.untrackedToPush));
		}
		if (branch.skipped.length) {
			lines.push(`  ${plural(branch.skipped.length, "file")} skipped:`);
			lines.push(
				...listLines(
					branch.skipped.map((file) => `${file.path} (${file.reason})`),
				),
			);
		}
	}
	const secretFiles = Object.entries(report.secrets).filter(
		([, names]) => names.length,
	);
	lines.push("");
	if (secretFiles.length)
		for (const [file, names] of secretFiles)
			lines.push(
				`Secrets from ${file} (values never shown; uploaded only with --secrets): ${names.join(", ")}`,
			);
	else lines.push("Secrets: no .env or .env.local in this folder.");
	if (report.needs.length) {
		lines.push("", "Needs the user's decision:");
		for (const need of report.needs) lines.push(`  - ${need}`);
	}
	lines.push(
		"",
		"Next: show this plan to the user and ask which scope to import. Then run:",
		`  ${report.next}`,
	);
	return lines.join("\n");
}

export function renderNeeds(report: NeedsReport) {
	return [
		"Not imported yet. Needs the user's decision:",
		...report.needs.map((need) => `  - ${need}`),
		"",
		"Ask the user, then run:",
		`  ${report.next}`,
	].join("\n");
}

export function renderDone(report: DoneReport) {
	const lines: string[] = [];
	lines.push(
		`Branch ${report.branch}${report.repository ? ` on ${report.repository}` : ""}: ${plural(report.pushed.length, "file")} pushed, ${report.skipped.length} skipped.`,
	);
	if (report.pushed.length)
		lines.push("Pushed:", ...listLines(report.pushed, 50));
	if (report.skipped.length)
		lines.push(
			"Skipped:",
			...listLines(
				report.skipped.map((file) => `${file.path} (${file.reason})`),
				50,
			),
		);
	for (const created of report.createdRepositories)
		lines.push(
			`Created private repository ${created.repository} for ${created.folder}.`,
		);
	for (const folder of report.skippedFolders)
		lines.push(`Not imported: ${folder.folder} (${folder.reason}).`);
	const sessions = report.sessions;
	lines.push(
		`Sessions: ${sessions.uploaded} imported${sessions.alreadyUploaded ? `, ${sessions.alreadyUploaded} already imported` : ""}${sessions.failed.length ? `, ${sessions.failed.length} failed` : ""}.`,
	);
	for (const failure of sessions.failed)
		lines.push(`  failed: ${failure.session}: ${failure.error}`);
	for (const missing of sessions.transcriptsMissing)
		lines.push(
			`  no full transcript for ${missing.session}: ${missing.reason}`,
		);
	if (report.secrets.length)
		lines.push(
			`Secrets: ${report.secrets.join(", ")} saved to the project for review.`,
		);
	lines.push("", `Done — open ${report.openUrl}`);
	return lines.join("\n");
}

export function renderError(report: ErrorReport) {
	return `Failed: ${report.error}\nNext: ${report.next}`;
}
