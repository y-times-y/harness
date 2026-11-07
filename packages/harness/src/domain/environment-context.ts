/** The builder's version: the setup report and how to treat baseline failures. */
export const BUILDER_ENVIRONMENT_INSTRUCTIONS =
	"The environment setup report (read_environment_report) lists the prepared revisions, setup steps and baseline check results; check it before changing code. A check that already failed in the baseline is an existing problem, not your regression: fix it only if it is part of the task, and never weaken checks to make them pass.";

export const PREPARED_ENVIRONMENT_INSTRUCTIONS =
	"If /tmp/ytimesy-environment.json exists, read its prepared revisions, setup recipes, and baseline checkResults before changing code. A nonzero baseline check exit is an existing failure or timeout, not proof of a regression in your work. Reproduce relevant failures and fix them on this task's branch only when within the user's task; report unrelated failures without silently changing them. Never weaken checks to claim success. When working on another revision, inspect changed dependency manifests and lockfiles and rerun the affected repository's setup when needed; do not reinstall unrelated repositories.";
