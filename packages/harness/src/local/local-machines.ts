import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
	AgentMachines,
	CommandOutput,
} from "../server/services/agent-machines";
import { LOCAL_PROVIDERS } from "./providers";

const OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

/** Runs one shell command to completion; on timeout the whole process group is killed. */
function runShell(
	command: string,
	cwd: string,
	timeoutMs: number,
	env: NodeJS.ProcessEnv,
): Promise<CommandOutput> {
	return new Promise((resolve) => {
		const child = spawn("bash", ["-lc", command], {
			cwd,
			env,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const append = (current: string, chunk: Buffer) =>
			current.length >= OUTPUT_LIMIT_BYTES
				? current
				: current + chunk.toString("utf8");
		child.stdout.on("data", (chunk: Buffer) => {
			stdout = append(stdout, chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = append(stderr, chunk);
		});
		const timer = setTimeout(() => {
			timedOut = true;
			if (child.pid) process.kill(-child.pid, "SIGKILL");
		}, timeoutMs);
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ exitCode: 127, stdout, stderr: `${stderr}${error.message}` });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({
				exitCode: timedOut ? 124 : (code ?? 1),
				stdout,
				stderr: timedOut
					? `${stderr}\nTimed out after ${Math.round(timeoutMs / 1000)}s.`
					: stderr,
			});
		});
	});
}

/**
 * The environment the agent's commands get: this process's, without the model
 * providers' API keys. The commands are written by a model and can be steered
 * by what it reads, so the key stays in this process.
 */
export function commandEnvironment(
	base: NodeJS.ProcessEnv,
	pathPrefix?: string,
): NodeJS.ProcessEnv {
	const env = { ...base };
	for (const provider of Object.values(LOCAL_PROVIDERS))
		delete env[provider.keyEnv];
	if (pathPrefix) env.PATH = `${pathPrefix}:${env.PATH ?? ""}`;
	return env;
}

/**
 * The agent's machine is this computer: commands run in a bash login shell
 * from `cwd`, files are read and written directly. `pathPrefix` goes in
 * front of the commands' PATH. The same AgentMachines shape a cloud VM or a
 * container provides.
 */
export function localMachines(
	cwd: string,
	options: { pathPrefix?: string } = {},
): AgentMachines {
	const env = commandEnvironment(process.env, options.pathPrefix);
	return {
		exec: (_workspaceId, command, timeoutMs = DEFAULT_TIMEOUT_MS) =>
			runShell(command, cwd, timeoutMs, env),
		readTextFile: async (_workspaceId, path) =>
			readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT" || error.code === "EISDIR") return null;
				throw error;
			}),
		readFile: async (_workspaceId, path) =>
			readFile(path).catch((error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT" || error.code === "EISDIR") return null;
				throw error;
			}),
		writeTextFile: async (_workspaceId, path, contents) => {
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, contents);
		},
	};
}
