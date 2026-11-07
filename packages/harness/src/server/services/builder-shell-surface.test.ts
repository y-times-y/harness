import { tool } from "ai";
import { expect, it } from "vitest";
import { z } from "zod";
import { harnessModelToolInstructions } from "../../domain/harness-model-profile";
import { builderShellTools } from "./builder-shell-surface";

it("keeps only the validated shell surface, which selects the shell prompt profile", () => {
	const make = () =>
		tool({ inputSchema: z.object({}), execute: async () => ({}) });
	const names = [
		"execute_command",
		"continue_command",
		"stop_command",
		"apply_patch",
		"read_repository_guidance",
		"report_task_blocked",
		"read_context_archive",
		"search_context_history",
		"run_checks",
		"apply_patches",
		"inspect_changes",
		"batch_read",
		"search_tools",
	];
	const kept = Object.keys(
		builderShellTools(Object.fromEntries(names.map((name) => [name, make()]))),
	);
	expect(kept).toEqual([
		"execute_command",
		"continue_command",
		"stop_command",
		"apply_patch",
		"report_task_blocked",
		"read_context_archive",
		"search_context_history",
	]);
	expect(harnessModelToolInstructions("openai", true, kept)).toContain(
		"v13-shell",
	);
	// Repository instructions are supplied as messages; the tool is never named.
	expect(harnessModelToolInstructions("openai", true, kept)).not.toContain(
		"read_repository_guidance",
	);
});

it("offers a shell surface exactly as given, without compose_tools or search_tools", async () => {
	const { discoverableAgentTools } = await import("./agent-tool-discovery");
	const { composedAgentTools } = await import("./composed-agent-tools");
	const { isShellSurface } = await import("../../domain/harness-model-profile");
	const make = () =>
		tool({ inputSchema: z.object({}), execute: async () => ({}) });
	const shell = { execute_command: make(), apply_patch: make() };
	expect(isShellSurface(Object.keys(shell))).toBe(true);
	expect(Object.keys(discoverableAgentTools(shell))).toEqual([
		"execute_command",
		"apply_patch",
	]);
	const specialist = { execute_command: make(), run_checks: make() };
	expect(isShellSurface(Object.keys(specialist))).toBe(false);
	expect(Object.keys(discoverableAgentTools(specialist))).toContain(
		"search_tools",
	);
	// The loop skips composition for shell surfaces; specialist surfaces still compose.
	expect(
		Object.keys(
			composedAgentTools({
				tools: specialist,
				signal: new AbortController().signal,
				onEvent: async () => {},
			}),
		),
	).toContain("compose_tools");
});

it("lets the product builder do visual QA without leaving the shell surface", async () => {
	const { discoverableAgentTools } = await import("./agent-tool-discovery");
	const { isShellSurface } = await import("../../domain/harness-model-profile");
	const make = () =>
		tool({ inputSchema: z.object({}), execute: async () => ({}) });
	const browser = [
		"browser_open",
		"browser_screenshot",
		"browser_inspect",
		"browser_execute",
	];
	const kept = Object.keys(
		builderShellTools(
			Object.fromEntries(
				["execute_command", "apply_patch", ...browser].map((name) => [
					name,
					make(),
				]),
			),
		),
	);
	expect(kept).toEqual(["execute_command", "apply_patch", ...browser]);
	expect(isShellSurface(kept)).toBe(true);
	const offered = discoverableAgentTools(
		Object.fromEntries(kept.map((name) => [name, make()])),
	);
	expect(Object.keys(offered)).not.toContain("search_tools");
	expect(
		Object.values(offered).every(
			(definition) => !(definition as { deferLoading?: boolean }).deferLoading,
		),
	).toBe(true);
});

it("gives a reader subagent a lean surface whose command tool runs, without write or edit, and prompts that name only its tools", async () => {
	const { builderToolSurface } = await import("./builder-shell-surface");
	const { agentTurnInstructions } = await import("./agent-turn-instructions");
	const { WorkspaceId } = await import("../../domain/ids");
	const commands: string[] = [];
	const base = {
		execute_command: tool({
			inputSchema: z.object({ command: z.string() }),
			execute: async ({ command }) => {
				commands.push(command);
				return {
					id: "c1",
					status: 0,
					stdout: "tests ok\n",
					start: 0,
					nextStart: null,
				};
			},
		}),
		continue_command: tool({
			inputSchema: z.object({}),
			execute: async () => ({}),
		}),
		report_task_blocked: tool({
			inputSchema: z.object({}),
			execute: async () => ({}),
		}),
	};
	const workspace = async () => ({
		machines: {} as never,
		vm: WorkspaceId("vm"),
		cwd: "/home/ubuntu/repo",
	});
	const surface = builderToolSurface({
		variant: "lean",
		modelId: "gpt-6.1-sol",
		tools: base,
		readOnly: true,
		lean: {
			workspace,
			sessionId: "reader",
			turnId: "turn",
			signal: new AbortController().signal,
			once: (_request, _fingerprint, run) => run(),
			installHelpers: async () => {},
		},
	});
	const names = Object.keys(surface.tools);
	expect(names).toEqual(["read", "bash", "report_task_blocked"]);
	expect(surface.lean?.readOnly).toBe(true);
	const bash = surface.tools.bash as unknown as {
		execute: (args: object, options: object) => Promise<unknown>;
	};
	const result = (await bash.execute(
		{ command: "python3 -m pytest -q" },
		{ toolCallId: "b1", messages: [] },
	)) as { output: string; status: number };
	expect(commands).toEqual(["python3 -m pytest -q"]);
	expect(result).toMatchObject({ status: 0, output: "tests ok\n" });

	for (const offered of [names, [...names, "run_code"]]) {
		const profile = harnessModelToolInstructions("openai", false, offered);
		expect(profile).toContain("v13-lean-reader");
		expect(profile).not.toMatch(/execute_command|Edit files|tools\.edit/);
	}
	const prompt = agentTurnInstructions({
		session: { agentRole: "checker", agentBudget: null } as never,
		tools: { ...surface.tools, run_code: base.report_task_blocked },
		plugins: [],
		projectKnowledge: null,
		leanShape: "core",
		leanReadOnly: true,
		codeMode: "primary",
	});
	expect(prompt).toContain("bash runs shell commands");
	expect(prompt).toContain("read-only user");
	expect(prompt).not.toMatch(
		/execute_command|edit and write|tools\.edit|ytimesy-check|ytimesy-browser/,
	);
});

it("keeps a builder's full lean surface and edit-first profile", async () => {
	const { leanSurfaceShape } = await import(
		"../../domain/harness-model-profile"
	);
	expect(leanSurfaceShape(["read", "write", "edit", "bash"])).toBe("core");
	expect(leanSurfaceShape(["read", "bash"])).toBe("core");
	expect(
		leanSurfaceShape([
			"run_shell_command",
			"read_file",
			"write_file",
			"edit",
			"glob",
			"grep_search",
		]),
	).toBe("qwen");
	const profile = harnessModelToolInstructions("openai", false, [
		"read",
		"write",
		"edit",
		"bash",
	]);
	expect(profile).toContain("v13-lean (openai): Edit files with edit");
});
