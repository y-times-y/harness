export const ENVIRONMENT_BUILD_TIMEOUT_SECONDS = 60 * 60;
export const ENVIRONMENT_BUILD_RECOVERY_SECONDS = 70 * 60;
export const ENVIRONMENT_JOB_TIMEOUT_SECONDS = 75 * 60;
/** A prepare request that never reached a build: shown with Retry in the UI. */
export const WORKSPACE_QUEUE_STALL_SECONDS = 5 * 60;
/** Cron fails a queued workspace whose prepare job never started a build. */
export const WORKSPACE_QUEUE_RECOVERY_SECONDS = 15 * 60;
