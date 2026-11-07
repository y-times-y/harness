import type { AgentToolWorkspace } from "../server/services/agent-tool-workspace";
import { leanHelperBundle } from "../server/services/lean-helpers";

/**
 * Puts the workspace commands the lean tool surface talks about
 * (ytimesy-job, ytimesy-check, ...) in ~/.ytimesy/bin on this computer.
 *
 * Only files under ~/.ytimesy are written: nothing is linked into a system
 * directory and no shell profile is edited. The local machine puts that
 * directory on the PATH of the commands the agent runs (local-machines.ts).
 */
export async function installLocalHelpers(
	workspace: Pick<AgentToolWorkspace, "machines" | "vm">,
	sessionId: string,
) {
	const { machines, vm } = workspace;
	const found = await machines.exec(vm, 'printf %s "$HOME"', 10_000);
	const home = found.stdout.trim();
	if (found.exitCode || !home.startsWith("/"))
		throw new Error("The home directory could not be found.");
	const root = `${home}/.ytimesy`;
	const bundle = leanHelperBundle(sessionId, `${root}/bin`);
	const marker = `${root}/${bundle.marker}`;
	const installed = await machines.exec(
		vm,
		`test -f '${marker}' && echo installed || echo missing`,
		10_000,
	);
	if (installed.stdout.includes("installed")) return;
	for (const [relative, file] of Object.entries(bundle.files)) {
		const path = `${root}/${relative}`;
		await machines.writeTextFile(vm, path, file.content);
		const mode = await machines.exec(
			vm,
			`chmod ${file.mode.toString(8)} '${path}'`,
			10_000,
		);
		if (mode.exitCode) throw new Error(`Could not set the mode of ${path}.`);
	}
	await machines.exec(
		vm,
		`mkdir -p '${root}/history' && touch '${marker}'`,
		10_000,
	);
}
