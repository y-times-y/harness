import { expect, it } from "vitest";
import {
	ENVIRONMENT_SETUP_PROMPT,
	ENVIRONMENT_SETUP_TITLE,
	isEnvironmentSetupPrompt,
	isSetupRequestMessage,
	setupRequestKeeping,
} from "./environment-setup";
import {
	environmentRecipe,
	unverifiedItemDetails,
} from "./project-environment";
import { sessionTitleFromText } from "./session-item";

it("saves what was verified instead of waiting for everything to work", () => {
	expect(ENVIRONMENT_SETUP_PROMPT).not.toMatch(/when everything works/i);
	expect(ENVIRONMENT_SETUP_PROMPT).toContain("save_project_environment");
	expect(ENVIRONMENT_SETUP_PROMPT).toMatch(/unverified/);
	expect(ENVIRONMENT_SETUP_PROMPT).toMatch(/optional runtime services/);
});

it("asks once for every variable the project expects, build secrets first", () => {
	expect(ENVIRONMENT_SETUP_PROMPT).toMatch(/\.env\.example or \.env\.sample/);
	expect(ENVIRONMENT_SETUP_PROMPT).toMatch(
		/ask me for all of them in one request_project_secret call/,
	);
	expect(ENVIRONMENT_SETUP_PROMPT).toMatch(/Ask only once/);
	expect(ENVIRONMENT_SETUP_PROMPT).toMatch(
		/install or build itself needs a secret, ask right away/,
	);
	expect(ENVIRONMENT_SETUP_PROMPT).toMatch(
		/If I skip some, finish and list them as not set/,
	);
});

it("restores regenerated tracked files and checks git status before claiming nothing changed", () => {
	expect(ENVIRONMENT_SETUP_PROMPT).toContain("git status --porcelain");
	expect(ENVIRONMENT_SETUP_PROMPT).toContain("git restore");
	expect(ENVIRONMENT_SETUP_PROMPT).toMatch(
		/only say nothing changed after git status --porcelain prints nothing/,
	);
});

it("recognizes the chip's request, unedited, and titles its chat", () => {
	expect(isEnvironmentSetupPrompt(`  ${ENVIRONMENT_SETUP_PROMPT}\n`)).toBe(
		true,
	);
	expect(isEnvironmentSetupPrompt("Set up this project's environment.")).toBe(
		false,
	);
	expect(sessionTitleFromText(ENVIRONMENT_SETUP_PROMPT)).toBe(
		ENVIRONMENT_SETUP_TITLE,
	);
	expect(ENVIRONMENT_SETUP_TITLE).toBe("Set up project");
	expect(sessionTitleFromText("Fix the parser")).toBe("Fix the parser");
});

it("starts from the build's report instead of installing and checking again", () => {
	// Where each tool surface keeps the report: a file (lean shapes) or a tool.
	expect(ENVIRONMENT_SETUP_PROMPT).toContain("~/.ytimesy/environment.md");
	expect(ENVIRONMENT_SETUP_PROMPT).toContain("read_environment_report");
	expect(ENVIRONMENT_SETUP_PROMPT).toMatch(/don't repeat what passed/);
	// A committed or saved setup that passed needs no new save.
	expect(ENVIRONMENT_SETUP_PROMPT).toMatch(
		/saved setup or \.ytimesy\/environment\.json and it passed, don't save anything/,
	);
});

it("still recognizes the request older tabs and chats sent", () => {
	const previous =
		"Set up this project's environment. Read the README and the manifests, install the dependencies, build, and run the project's checks (typecheck, lint, tests). If install or build needs a secret, ask me for it with request_project_secret. Don't wait on optional runtime services: if something (a dev server, a service, a check) can't run without a secret or an outside service, skip it. Then save what you verified with save_project_environment, and list what you could not verify and why (with the missing secret names) as unverified. Don't change the project's code. Before you finish, run git status --porcelain, restore every tracked file your commands changed (git restore <path>), and only say nothing changed after git status --porcelain prints nothing.";
	expect(isEnvironmentSetupPrompt(previous)).toBe(true);
	expect(sessionTitleFromText(previous)).toBe("Set up project");
	// The one-flow request from before setup asked for every variable.
	const buildSecretsOnly =
		"Set up this project. The machine already cloned it, ran the detected install and the detected checks: start with its environment report (~/.ytimesy/environment.md, or read_environment_report when you have that tool) and don't repeat what passed there (that install counts as verified). If the report says the setup came from a saved setup or .ytimesy/environment.json and it passed, don't save anything; say the project is ready. Otherwise read the README and the manifests, run only what is still unverified (install, build, typecheck, lint, tests; independent ones together), and save what passed with save_project_environment. If install or build needs a secret, ask me for it with request_project_secret. Don't wait on optional runtime services: if something (a dev server, a service, a check) can't run without a secret or an outside service, skip it and list it as unverified with the reason and the missing secret names. Don't change the project's code. Before you finish, run git status --porcelain, restore every tracked file your commands changed (git restore <path>), and only say nothing changed after git status --porcelain prints nothing. Keep the final message to a few short lines.";
	expect(isEnvironmentSetupPrompt(buildSecretsOnly)).toBe(true);
});

it("shows the request, and the request keeping a held message, as the setup's own line", () => {
	expect(isSetupRequestMessage(ENVIRONMENT_SETUP_PROMPT)).toBe(true);
	expect(isSetupRequestMessage(setupRequestKeeping("Add a login page"))).toBe(
		true,
	);
	expect(isSetupRequestMessage("Add a login page")).toBe(false);
	expect(
		isSetupRequestMessage(`Please: ${setupRequestKeeping("Add a login page")}`),
	).toBe(false);
});

it("keeps unverified items on a recipe and leaves older recipes without them", () => {
	const recipe = environmentRecipe.parse({
		install: "pnpm install",
		unverified: [
			{
				what: "Dev server",
				reason: "Needs the realtime secret to start.",
				secrets: ["REALTIME_KEY"],
			},
		],
	});
	expect(recipe.unverified).toHaveLength(1);
	expect(unverifiedItemDetails(recipe.unverified?.[0] as never)).toBe(
		"Needs the realtime secret to start. Needs REALTIME_KEY.",
	);
	expect(
		environmentRecipe.parse({ install: "pnpm install" }),
	).not.toHaveProperty("unverified");
	expect(
		environmentRecipe.safeParse({
			unverified: [{ what: "Dev server", reason: "x", secrets: ["bad name"] }],
		}).success,
	).toBe(false);
});
