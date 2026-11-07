/** When the agent must check its work on screen, and what evidence it reports. */
/** Visual QA for the lean surfaces, through the ytimesy-browser workspace command. */
export function leanVisualQaInstructions(
	tools: {
		command: string;
		image: string;
	},
	options: { prEvidence?: boolean } = {},
): string {
	return `${leanVisualQaText(tools)}${options.prEvidence ? ` ${PR_EVIDENCE_INSTRUCTION}` : ""}`;
}

/** One line (harness variant prEvidence=on): how the builder asks for pull request evidence. */
export const PR_EVIDENCE_INSTRUCTION =
	"PR evidence: when a change is visible, run `ytimesy-evidence capture --start '<dev server command>' --url <localhost URL or /path> [--flow steps.json]` (or `--cli '<command>'` for CLI output) once it works; it previews now and saves the plan, and at pull request handoff the harness re-captures screenshots and a short recording from the pushed commit for the PR description.";

function leanVisualQaText(tools: { command: string; image: string }) {
	return `Visual QA: when a change affects what a user sees (pages, components, styles, layout) or the task asks you to check the UI, verify it on the shared desktop before reporting done. Start the app with ${tools.command} (a dev server in the background), open it with \`ytimesy-browser open <localhost URL>\`, then \`ytimesy-browser screenshot\` and look at the PNG it prints with ${tools.image}; \`ytimesy-browser inspect <url>\` checks text, console and network, and \`ytimesy-browser exec\` (Browser Use) clicks, types and asserts behavior. For windows outside Chrome (native dialogs, other apps), run xdotool with DISPLAY=:0. The first ytimesy-browser command starts the shared desktop, which the user can watch in the Desktop tab. Fix what the screenshot shows is wrong. In the final report, state the URL you checked and what the screenshot showed, or why visual QA was not possible. ${LEAN_CAPTURES_INSTRUCTION}`;
}

/** Showing the user (and the pull request) a screenshot or recording without committing it. */
export const LEAN_CAPTURES_INSTRUCTION =
	"Asked for a screenshot or recording (also for the PR)? Use `ytimesy-browser screenshot` or `record <seconds>`: they show in the chat and the PR's Evidence section, so never commit media files unless the user wants them in the repository.";

export function visualQaInstructions(): string {
	return "Visual QA: when a change affects what a user sees (pages, components, styles, layout) or the task asks you to check the UI, verify it on the shared desktop before reporting done. Start the app with execute_command (a dev server in the background), open it with browser_open on its localhost URL, then browser_screenshot and look at the image; use browser_inspect to check text, console and network, and, when offered, browser_execute (Browser Use) to click, type and assert behavior. For windows outside Chrome (native dialogs, other apps), run xdotool through execute_command with DISPLAY=:0. The first browser tool starts the shared desktop, which the user can watch in the Desktop tab. Fix what the screenshot shows is wrong. In the final report, state the URL you checked and what the screenshot showed, or why visual QA was not possible.";
}
