/**
 * The project setup's request: sent by itself, as the system, in the chat a
 * new project opens (and by "Rerun setup"). The build already cloned the
 * project, installed what it detected and ran the detected checks, so the
 * agent starts from that report instead of repeating it (each repeated
 * install or check cost a model round trip and its run time).
 */
export const ENVIRONMENT_SETUP_PROMPT =
	"Set up this project. The machine already cloned it, ran the detected install and the detected checks: start with its environment report (~/.ytimesy/environment.md, or read_environment_report when you have that tool) and don't repeat what passed there (that install counts as verified). If the report says the setup came from a saved setup or .ytimesy/environment.json and it passed, don't save anything. Otherwise read the README and the manifests, run only what is still unverified (install, build, typecheck, lint, tests; independent ones together), and save what passed with save_project_environment. Then find every environment variable the project expects (.env.example or .env.sample, the README, config files) that is not already a project secret, and ask me for all of them in one request_project_secret call (kind environment for non-sensitive settings, runtime otherwise; one short reason each). Ask only once: if install or build itself needs a secret, ask right away, with the rest in that same call. If I skip some, finish and list them as not set. Don't wait on optional runtime services: if something (a dev server, a service, a check) can't run without a secret or an outside service, skip it and list it as unverified with the reason and the missing secret names. Don't change the project's code. Before you ask and before you finish, run git status --porcelain, restore every tracked file your commands changed (git restore <path>), and only say nothing changed after git status --porcelain prints nothing. Keep the final message to a few short lines.";

/** Earlier wordings of the request (the "Set up environment" one, then the one that asked only for build secrets); old chats and tabs still carry them. */
const PREVIOUS_SETUP_PROMPTS = [
	"Set up this project's environment. Read the README and the manifests, install the dependencies, build, and run the project's checks (typecheck, lint, tests). If install or build needs a secret, ask me for it with request_project_secret. Don't wait on optional runtime services: if something (a dev server, a service, a check) can't run without a secret or an outside service, skip it. Then save what you verified with save_project_environment, and list what you could not verify and why (with the missing secret names) as unverified. Don't change the project's code. Before you finish, run git status --porcelain, restore every tracked file your commands changed (git restore <path>), and only say nothing changed after git status --porcelain prints nothing.",
	"Set up this project. The machine already cloned it, ran the detected install and the detected checks: start with its environment report (~/.ytimesy/environment.md, or read_environment_report when you have that tool) and don't repeat what passed there (that install counts as verified). If the report says the setup came from a saved setup or .ytimesy/environment.json and it passed, don't save anything; say the project is ready. Otherwise read the README and the manifests, run only what is still unverified (install, build, typecheck, lint, tests; independent ones together), and save what passed with save_project_environment. If install or build needs a secret, ask me for it with request_project_secret. Don't wait on optional runtime services: if something (a dev server, a service, a check) can't run without a secret or an outside service, skip it and list it as unverified with the reason and the missing secret names. Don't change the project's code. Before you finish, run git status --porcelain, restore every tracked file your commands changed (git restore <path>), and only say nothing changed after git status --porcelain prints nothing. Keep the final message to a few short lines.",
] as const;

/** The setup's one name, wherever it shows: a chat's title, its row, the menu. */
export const PROJECT_SETUP_NAME = "Set up project";

/** Starting setup again for a project that has run it. */
export const RERUN_SETUP_LABEL = "Rerun setup";

/** A setup chat's title, whatever its first message says. */
export const ENVIRONMENT_SETUP_TITLE = PROJECT_SETUP_NAME;

/** Setup chats titled before setup became one flow. */
export const PREVIOUS_SETUP_TITLES = ["Set up environment"] as const;

/** A project's setup chat, as a chat list names it. */
export function isSetupChatTitle(title: string) {
	return (
		title === ENVIRONMENT_SETUP_TITLE ||
		(PREVIOUS_SETUP_TITLES as readonly string[]).includes(title)
	);
}

const SETUP_KEEPING_MARKER =
	"\n\nThe setup failed before this message could be sent. Keep it for after setup, in a new chat (not here):\n";

const normalized = (text: string) => text.replace(/\s+/g, " ").trim();

/** The setup's request, sent unedited (whitespace aside), this one or an earlier wording. */
export function isEnvironmentSetupPrompt(text: string): boolean {
	const sent = normalized(text);
	return [ENVIRONMENT_SETUP_PROMPT, ...PREVIOUS_SETUP_PROMPTS].some(
		(prompt) => sent === normalized(prompt),
	);
}

/**
 * A chat message that is the setup's own request (shown as one line, not
 * as the person's message): the request, or the request keeping a message
 * a failed setup held (setupRequestKeeping).
 */
export function isSetupRequestMessage(text: string): boolean {
	if (isEnvironmentSetupPrompt(text)) return true;
	const kept = text.indexOf(SETUP_KEEPING_MARKER);
	return kept > 0 && isEnvironmentSetupPrompt(text.slice(0, kept));
}

/**
 * The setup a new project starts by itself has one message id per project,
 * so a second start (another tab, a reload, a retried request) finds the
 * first instead of starting setup again.
 */
export function initialSetupMessageId(projectId: string): string {
	const hex = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b]
		.map((seed) => fnv1a(`ytimesy:initial-setup:${projectId}`, seed))
		.map((word) => word.toString(16).padStart(8, "0"))
		.join("");
	// Shaped as a version-4 UUID: message ids are validated as UUIDs.
	const variant = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(
		16,
	);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** 32-bit FNV-1a; runs the same in the browser and on the server. */
function fnv1a(text: string, seed: number) {
	let hash = seed >>> 0;
	for (let index = 0; index < text.length; index++) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash;
}

/**
 * "Fix with the agent" on a message held by a failed setup: the setup
 * chat's request, keeping the message the person sent (not dropped) for a
 * later chat, since a setup chat never commits.
 */
export function setupRequestKeeping(message: string) {
	return `${ENVIRONMENT_SETUP_PROMPT}${SETUP_KEEPING_MARKER}${message.trim()}`;
}
