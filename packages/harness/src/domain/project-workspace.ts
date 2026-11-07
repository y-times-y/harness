import { WORKSPACE_QUEUE_STALL_SECONDS } from "./environment-build-limits";

const workspaceStatuses = [
	"queued",
	"provisioning",
	"cloning",
	"installing",
	"ready",
	"failed",
] as const;
export type WorkspaceStatus = (typeof workspaceStatuses)[number];

export interface ProjectWorkspace {
	id: string;
	userId: string;
	projectId: string;
	status: WorkspaceStatus;
	providerRef: string | null;
	templateSnapshotId: string | null;
	templateSourceRef?: string | null;
	templateSourceSha?: string | null;
	errorMessage: string | null;
	updatedAt: string;
}

export function canStartPrepare(status: WorkspaceStatus | undefined) {
	return status === undefined || status === "queued" || status === "failed";
}

/** Queued long enough that the prepare job was probably never handed off. */
export function workspacePrepareStalled(
	workspace: { readonly status: WorkspaceStatus; readonly updatedAt: string },
	now: number,
) {
	const queuedAt = Date.parse(workspace.updatedAt);
	return (
		workspace.status === "queued" &&
		Number.isFinite(queuedAt) &&
		now - queuedAt >= WORKSPACE_QUEUE_STALL_SECONDS * 1000
	);
}

export function workspacePrepareShowsStatus(
	status: WorkspaceStatus | undefined,
) {
	return status === "failed";
}

export type WorkspaceEnvironmentState = Pick<
	ProjectWorkspace,
	"status" | "providerRef"
> & {
	templateSnapshotId?: string | null;
	errorMessage?: string | null;
};

/**
 * Agents copy from the sealed snapshot. The unused template VM is optional
 * once that snapshot exists; pausing or deleting it must not block Connect.
 */
export function workspaceEnvironmentIsReady(
	workspace: WorkspaceEnvironmentState | null,
) {
	if (workspace?.status !== "ready") return false;
	return Boolean(workspace.providerRef || workspace.templateSnapshotId);
}

export function branchSwitchBlockedReason(
	status: WorkspaceStatus | undefined,
): string | null {
	if (
		status === "provisioning" ||
		status === "cloning" ||
		status === "installing"
	)
		return "Wait for workspace preparation to finish.";
	return null;
}

export function blocksDuplicateProvision(status: WorkspaceStatus) {
	return (
		status === "ready" ||
		status === "provisioning" ||
		status === "cloning" ||
		status === "installing"
	);
}

export function redactSecrets(value: string) {
	return value
		.replace(/ghp_[A-Za-z0-9]+/g, "[redacted]")
		.replace(/github_pat_[A-Za-z0-9_]+/g, "[redacted]")
		.replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
		.replace(
			/AUTHORIZATION:\s*bearer\s+\S+/gi,
			"AUTHORIZATION: bearer [redacted]",
		)
		.replace(
			/AUTHORIZATION:\s*basic\s+\S+/gi,
			"AUTHORIZATION: basic [redacted]",
		)
		.replace(/x-access-token:[^@\s]+@/g, "x-access-token:***@");
}

/** What a composer send says about itself, as far as setup is concerned. */
export type SetupRelevantSend = {
	/** The project's setup request (a new project's own, or Rerun setup). */
	readonly environmentSetup?: boolean;
	/** Runtime sends (notices, plan approvals, fallback continuations). */
	readonly runtimeText?: string;
	readonly approvesPlan?: boolean;
	readonly continueOn?: string;
};

const sentByPerson = (send: SetupRelevantSend) =>
	send.runtimeText === undefined && !send.approvesPlan && !send.continueOn;

/**
 * Only the project's setup request waits for the environment: the setup
 * agent starts from the build's report. A task never waits; its machine
 * boots without the template (sessionMachinePlan).
 */
export function sendWaitsForEnvironment(send: SetupRelevantSend) {
	return Boolean(send.environmentSetup) && sentByPerson(send);
}

/** A task the person sent (not the setup's own request) may start the setup beside it. */
export function startsSetupBesideTask(send: SetupRelevantSend) {
	return !send.environmentSetup && sentByPerson(send);
}

/** The project's first environment build is under way: no template exists yet. */
export function firstEnvironmentBuildRunning(
	workspace: Pick<ProjectWorkspace, "status" | "templateSnapshotId">,
) {
	return (
		!workspace.templateSnapshotId &&
		(workspace.status === "queued" ||
			workspace.status === "provisioning" ||
			workspace.status === "cloning" ||
			workspace.status === "installing")
	);
}

/**
 * The setup request sent while the project's environment is not ready is
 * held in its chat: during the build, and after a failed build too (it
 * shows the failure with Retry; a held message is never dropped). Any other
 * send goes at once. Unknown status (still loading) sends as usual.
 */
export function sendWaitsForSetup(
	status: WorkspaceStatus | "missing" | undefined,
	send: SetupRelevantSend,
) {
	return (
		status !== undefined && status !== "ready" && sendWaitsForEnvironment(send)
	);
}

/**
 * A held message goes out once nothing holds it: the setup request (the
 * default) once the environment is ready; a task held only because the
 * project had no environment record yet, once it has one.
 */
export function heldSendReleases(
	status: WorkspaceStatus | undefined,
	send: SetupRelevantSend = { environmentSetup: true },
) {
	return status !== undefined && !sendWaitsForSetup(status, send);
}
