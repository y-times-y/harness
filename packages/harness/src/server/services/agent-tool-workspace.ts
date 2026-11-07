import type { WorkspaceId } from "../../domain/ids";
import type { AgentMachines } from "./agent-machines";

export type AgentToolWorkspace<M extends AgentMachines = AgentMachines> = {
	machines: M;
	vm: WorkspaceId;
	cwd: string;
};
export type AgentToolWorkspaceInput<M extends AgentMachines = AgentMachines> =
	| AgentToolWorkspace<M>
	| { workspace: () => Promise<AgentToolWorkspace<M>> };
export function resolveToolWorkspace<M extends AgentMachines = AgentMachines>(
	input: AgentToolWorkspaceInput<M>,
): Promise<AgentToolWorkspace<M>> {
	return "workspace" in input ? input.workspace() : Promise.resolve(input);
}
