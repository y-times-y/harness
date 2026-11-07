import type { WorkspaceId } from "../../domain/ids";

export interface CommandOutput {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

/**
 * The machine an agent works on: everything the harness's tools ask of it.
 * A laptop (local-machines.ts), a container or a cloud VM each
 * provide these operations; the harness never needs more.
 */
export interface AgentMachines {
	readonly exec: (
		workspaceId: WorkspaceId,
		command: string,
		timeoutMs?: number,
	) => Promise<CommandOutput>;
	readonly writeTextFile: (
		workspaceId: WorkspaceId,
		path: string,
		contents: string,
	) => Promise<void>;
	/** Null when the file does not exist. */
	readonly readTextFile: (
		workspaceId: WorkspaceId,
		path: string,
	) => Promise<string | null>;
	readonly readFile?: (
		workspaceId: WorkspaceId,
		path: string,
	) => Promise<Uint8Array | null>;
	/** Runs a language, debugger or browser capability the machine offers, when it has any. */
	readonly runCapability?: (
		workspaceId: WorkspaceId,
		request: {
			capability: "language" | "debugger" | "browser";
			source: string;
			arguments: unknown;
			onlyInstalled?: boolean;
		},
		signal: AbortSignal,
	) => Promise<CommandOutput>;
}
