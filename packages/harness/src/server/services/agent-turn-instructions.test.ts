import { tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	BRIEF_POLICY,
	KEEP_WORKING_POLICY,
	READER_DELEGATION_POLICY,
	REFUSED_START,
	REPORT_IS_A_CLAIM,
	WRITER_DELEGATION_POLICY,
} from "../../domain/delegation-policy";
import {
	type FusionPairProfile,
	fusionPairProfile,
} from "../../domain/fusion-pairs";
import { beginSidekickRound, newSidekickState } from "../../domain/sidekick";
import {
	FORCED_DELEGATION,
	ROOT_HELPER_UPDATES,
} from "../../domain/subagent-instructions";
import { agentTurnInstructions } from "./agent-turn-instructions";

const stub = tool({
	description: "stub",
	inputSchema: z.object({}),
	execute: async () => "",
});

const base = {
	plugins: [],
	projectKnowledge: null,
	leanShape: "core" as const,
	leanWorkingDirectory: "/home/user/app",
};

describe("rigor instructions", () => {
	it("gives the rigor block to the builder and writers under rigor=on only", () => {
		const block = "Ambiguous wording: list the plausible readings";
		const root = {};
		expect(
			agentTurnInstructions({ ...base, session: root, tools: { bash: stub } }),
		).not.toContain(block);
		expect(
			agentTurnInstructions({
				...base,
				session: root,
				tools: { bash: stub },
				rigor: true,
			}),
		).toContain(block);
		expect(
			agentTurnInstructions({
				...base,
				leanShape: undefined,
				session: root,
				tools: { bash: stub },
				rigor: true,
			}),
		).toContain(block);
		expect(
			agentTurnInstructions({
				...base,
				session: { agentRole: "writer" as const },
				tools: { bash: stub },
				rigor: true,
			}),
		).toContain(block);
		for (const agentRole of ["checker", "researcher", "reviewer"] as const)
			expect(
				agentTurnInstructions({
					...base,
					session: { agentRole },
					tools: { bash: stub },
					leanReadOnly: true,
					rigor: true,
				}),
			).not.toContain(block);
	});
});

describe("rigor requirements list", () => {
	const list =
		"- Requirements: before you start, write the request's requirements";
	const lead = "- As Main, write the list right after the exploration report";
	it("asks the root builder (a fusion lead included) for the list, never a writer or sidekick", () => {
		const tools = { bash: stub, agent: stub, run_code: stub };
		const root = agentTurnInstructions({
			...base,
			session: {},
			tools: { bash: stub },
			rigor: true,
		});
		expect(root).toContain(list);
		expect(root).not.toContain(lead);
		expect(
			agentTurnInstructions({
				...base,
				leanShape: undefined,
				session: {},
				tools: { bash: stub },
				rigor: true,
			}),
		).toContain(list);
		const fusion = agentTurnInstructions({
			...base,
			session: {},
			tools,
			lead: "fusion",
			rigor: true,
		});
		expect(fusion).toContain(list);
		expect(fusion).toContain(lead);
		expect(
			agentTurnInstructions({ ...base, session: {}, tools, lead: "fusion" }),
		).not.toContain(list);
		for (const session of [
			{ agentRole: "writer" as const },
			{
				agentRole: "writer" as const,
				agentBudget: {
					steps: 10,
					minutes: 5,
					tokens: 1000,
					sidekick: undefined,
				},
			},
		]) {
			const writer = agentTurnInstructions({
				...base,
				session,
				tools: { bash: stub },
				lead: "fusion",
				rigor: true,
			});
			expect(writer).not.toContain(list);
			expect(writer).not.toContain(lead);
		}
	});
});

describe("subagent instructions", () => {
	it("requires delegation only of the root builder under subagents=force", () => {
		const tools = { bash: stub, agent: stub, run_code: stub };
		const forced = agentTurnInstructions({
			...base,
			session: {},
			tools,
			forceDelegation: true,
		});
		expect(forced).toContain(FORCED_DELEGATION);
		expect(
			agentTurnInstructions({ ...base, session: {}, tools }),
		).not.toContain(FORCED_DELEGATION);
		expect(
			agentTurnInstructions({
				...base,
				session: { agentRole: "writer" },
				tools,
				forceDelegation: true,
			}),
		).not.toContain(FORCED_DELEGATION);
	});
	it("teaches the builder cost-aware orchestration only when it has the agent tool", () => {
		const without = agentTurnInstructions({
			...base,
			session: {},
			tools: { bash: stub },
		});
		expect(without).not.toContain("Subagents:");
		const withAgent = agentTurnInstructions({
			...base,
			session: {},
			tools: { bash: stub, agent: stub, run_code: stub },
			codeMode: "on",
		});
		// agent is an ordinary tool: no loading, no deferred list.
		expect(withAgent).toContain(
			"Subagents: `agent` starts a helper (a background agent) with only your brief and returns its id at once;",
		);
		expect(withAgent).not.toMatch(/find_tools|searchTools|More tools/);
		// The shared delegation policy, as unattended runs use it.
		expect(withAgent).toContain(WRITER_DELEGATION_POLICY);
		expect(withAgent).toContain(READER_DELEGATION_POLICY);
		expect(withAgent).toContain(BRIEF_POLICY);
		expect(withAgent).toContain(KEEP_WORKING_POLICY);
		expect(withAgent).toContain(REPORT_IS_A_CLAIM);
		expect(withAgent).toContain(REFUSED_START);
		// The earlier, looser product triggers are gone.
		expect(withAgent).not.toContain("Delegate when it saves wall-clock time");
		expect(withAgent).not.toContain("each likely to take over 5 minutes");
		expect(withAgent).not.toContain(
			"after a hard fix, a reviewer can check it",
		);
		expect(withAgent).not.toContain("isolation: a risky or exploratory change");
		// One parallel example (arguments come from the schema).
		expect(withAgent).toContain(
			'Start helpers that run side by side together, in one run_code program: await Promise.all([tools.agent({ role: "writer"',
		);
		expect(withAgent).not.toContain("Arguments: agent(");
		expect(withAgent).not.toContain("Cost first");
		// The root role line allows what the block describes.
		expect(withAgent).toContain(
			"answer the user yourself, delegating only as below.",
		);
		expect(withAgent).not.toContain("work directly in this workspace");
		expect(without).toContain("work directly in this workspace");
		expect(without).not.toContain("delegating");
		// The product's own mechanics: forks returning patches, reports as messages.
		expect(withAgent).toContain("what not to touch");
		expect(withAgent).toContain("returns a patch and git ref");
		expect(withAgent).toContain("git apply -3");
		expect(withAgent).not.toContain("agent_wait");
		expect(withAgent).not.toContain("`owns`");
		// Reports wake the builder; no progress pings; the root posts each finish.
		expect(withAgent).toContain(
			"Their reports arrive on their own and wake you; message a running helper only to change its course or stop it, never to ask for progress or to hurry it.",
		);
		expect(withAgent).toContain(ROOT_HELPER_UPDATES);
		const writer = agentTurnInstructions({
			...base,
			session: { agentRole: "writer" },
			tools: { bash: stub, agent: stub },
		});
		expect(writer).toContain("Their reports arrive on their own and wake you");
		expect(writer).not.toContain(ROOT_HELPER_UPDATES);
	});

	it("in code mode primary, teaches run_code as the main tool and sends only deferred MCP tools through it", () => {
		const primary = agentTurnInstructions({
			...base,
			session: {},
			tools: { bash: stub, agent: stub, run_code: stub },
			deferredTools: [
				{ name: "search_mcp_tools", description: "Search MCP tools." },
			],
			codeMode: "primary",
		});
		expect(primary).toContain("run_code is your main tool");
		expect(primary).toContain(
			"Your tools: run_code runs programs that call bash, read, edit and write; bash runs shell commands;",
		);
		expect(primary).toContain(
			"Explore with one run_code program: list the tree and read the task's files with Promise.all.",
		);
		expect(primary).toContain(
			"Once you know the fix, make all planned edits and run the tests in ONE run_code program.",
		);
		expect(primary).not.toContain("run_code runs one JavaScript program");
		expect(primary).toContain(
			"call them from inside run_code as tools.<name>(args)",
		);
		expect(primary).toContain("- search_mcp_tools: Search MCP tools.");
		expect(primary).not.toContain("call it from run_code");
		expect(primary).not.toContain("find_tools");
		// Nothing deferred: searchTools goes unmentioned.
		const nothingDeferred = agentTurnInstructions({
			...base,
			session: {},
			tools: { bash: stub, agent: stub, run_code: stub },
			deferredTools: [],
			codeMode: "primary",
		});
		expect(nothingDeferred).not.toMatch(/searchTools|ALL_TOOLS|find_tools/);
		expect(nothingDeferred).toContain("Subagents: `agent` starts");
	});

	it("gives a subagent its role, budget and report contract instead of the chat's role", () => {
		const reviewer = agentTurnInstructions({
			...base,
			session: {
				agentRole: "reviewer",
				agentBudget: { steps: 75, minutes: 15, tokens: 1_000_000 },
			},
			tools: { bash: stub },
		});
		expect(reviewer).toContain("read-only reviewer subagent");
		expect(reviewer).toContain("75 steps, 15 minutes, 1,000,000 tokens");
		expect(reviewer).toContain("You see only your brief");
		expect(reviewer).not.toContain("You are the coding agent for this chat");
		expect(reviewer).not.toContain("draft PRs");
		const writer = agentTurnInstructions({
			...base,
			session: {
				agentRole: "writer",
				agentBudget: null,
			},
			tools: { bash: stub },
		});
		expect(writer).toContain(
			"receives your work as a patch to review and apply",
		);
		expect(writer).not.toContain("push");
	});

	it("without code mode, asks for direct parallel agent calls; a reader never starts writers", () => {
		const direct = agentTurnInstructions({
			...base,
			session: {},
			tools: { bash: stub, agent: stub },
		});
		expect(direct).toContain(
			"Start helpers that run side by side together, with one agent call per helper in the same step.",
		);
		expect(direct).not.toContain("run_code");
		const researcher = agentTurnInstructions({
			...base,
			leanReadOnly: true,
			session: {
				agentRole: "researcher",
				agentBudget: null,
			},
			tools: { bash: stub, read: stub, agent: stub, run_code: stub },
			codeMode: "primary",
		});
		expect(researcher).toContain(
			"You may start only researchers, reviewers and checkers.",
		);
		expect(researcher).toContain('tools.agent({ role: "researcher"');
		expect(researcher).not.toMatch(/writer|git apply/);
		// Readers start readers under the same cost bar, never the writer rule.
		expect(researcher).toContain(READER_DELEGATION_POLICY);
		expect(researcher).not.toContain(WRITER_DELEGATION_POLICY);
	});
});

describe("lead mode fusion instructions", () => {
	const lead = (
		leanShape: "core" | "codex" | "claude",
		tools: Record<string, typeof stub>,
		variant?: "off" | "fusion",
	) =>
		agentTurnInstructions({
			...base,
			leanShape,
			session: {},
			tools,
			lead: variant,
		});

	it("replaces the orchestration block with the lead's for the root builder", () => {
		const fusion = lead(
			"core",
			{
				bash: stub,
				read: stub,
				edit: stub,
				write: stub,
				agent: stub,
				agent_send: stub,
			},
			"fusion",
		);
		expect(fusion).toContain("Helpers: you are Main.");
		expect(fusion).toContain(
			"Short or trivial changes (one obvious edit): make them yourself",
		);
		// Shared checkout, one writer at a time: Main is free but cannot write during a round.
		expect(fusion).toContain(
			"It works directly in your checkout, one writer at a time: while its round runs your edits and commands are refused",
		);
		expect(fusion).toContain(
			"After you hand a round off, do not wait for it: give the user a full status",
		);
		expect(fusion).not.toMatch(/\b[Ll]ead\b|[Ss]idekick/);
		expect(fusion).toContain("`git diff <start> <end>`");
		expect(fusion).toContain("your answer to the user is a full report");
		expect(fusion).toContain(
			"message it only to change its course or stop it, never to ask for progress or to hurry it.",
		);
		expect(fusion).toContain(ROOT_HELPER_UPDATES);
		expect(fusion).not.toContain("git apply");
		expect(fusion).toContain(
			"the definition of done as concrete checks or commands that must pass",
		);
		expect(fusion).toContain(
			"send specific feedback with `agent_send` (what fails, where, what done looks like) for another round instead of fixing it yourself",
		);
		expect(fusion).toContain(
			"re-brief it more prescriptively, or take over and edit yourself (`edit`, `write`).",
		);
		// Exploration first, started by the runtime: the lead plans from its snippets.
		expect(fusion).toContain(
			"Each user request starts with your writer's exploration: the runtime gives it the request before your first step",
		);
		expect(fusion).toContain(
			"read a file yourself (`read`) only to fill a specific gap they leave,",
		);
		expect(fusion).toContain("across the user's messages");
		// Not the default block's delegation policy.
		expect(fusion).not.toContain(WRITER_DELEGATION_POLICY);
		expect(fusion).toContain(
			"answer the user yourself, delegating only as below.",
		);
		const off = lead("core", { bash: stub, edit: stub, agent: stub }, "off");
		expect(off).toContain(WRITER_DELEGATION_POLICY);
		expect(off).not.toContain("you are Main");
	});

	it("gives the thin lead (leadTools=thin) the decide-not-do block without the builder's workspace commands", () => {
		const thin = agentTurnInstructions({
			...base,
			leanShape: "codex",
			session: {},
			tools: { exec_command: stub, agent: stub, agent_send: stub },
			lead: "fusion",
			leadTools: "thin",
			fusionPair: fusionPairProfile("gpt-6.1-sol", "gpt-6-luna"),
		});
		expect(thin).toContain("You decide; your writer does.");
		expect(thin).toContain("`exec_command` only inspect");
		expect(thin).toContain("Acceptance checks");
		expect(thin).toContain("Up to 2 restarts per request");
		expect(thin).not.toContain("ytimesy-check");
		expect(thin).not.toContain("take over and edit yourself");
		const blocking = agentTurnInstructions({
			...base,
			leanShape: "core",
			session: {},
			tools: { bash: stub, read: stub, agent: stub },
			lead: "fusion",
			leadTools: "thin",
			leadBlocking: true,
		});
		expect(blocking).toContain("restart: true");
		expect(blocking).toContain("wait for the round and return its report");
	});

	it("shapes briefs, pushback and exploration by the pair's profile", () => {
		const tools = { bash: stub, read: stub, edit: stub, agent: stub };
		const withPair = (pair: FusionPairProfile) =>
			agentTurnInstructions({
				...base,
				leanShape: "core",
				session: {},
				tools,
				lead: "fusion",
				fusionPair: pair,
			});
		const solLuna = withPair(fusionPairProfile("gpt-6.1-sol", "gpt-6-luna"));
		expect(solLuna).toContain("Brief prescriptively:");
		expect(solLuna).not.toContain("Brief by outcome");
		expect(solLuna).toContain("explore: true");
		const strong = withPair(fusionPairProfile("gpt-6.1-sol", "gpt-6.1-sol"));
		expect(strong).toContain("Brief by outcome");
		expect(strong).toContain("It may push back on your approach");
		const noExplore = withPair({
			name: "test",
			briefStyle: "outcome",
			pushback: false,
			sidekickExplores: false,
		});
		expect(noExplore).not.toContain("starts with your writer's exploration");
		expect(noExplore).not.toContain("push back");
	});

	it("names the surface's own editing tools", () => {
		expect(
			lead(
				"codex",
				{ exec_command: stub, apply_patch: stub, agent: stub },
				"fusion",
			),
		).toContain("take over and edit yourself (`apply_patch`).");
		expect(
			lead(
				"claude",
				{ Bash: stub, Edit: stub, Write: stub, agent: stub },
				"fusion",
			),
		).toContain("take over and edit yourself (`Edit`, `Write`).");
	});

	it("gives the sidekick its persistent role and per-round budget, never the lead's block", () => {
		const budget = { steps: 150, minutes: 30, tokens: 2_000_000 };
		const sidekick = agentTurnInstructions({
			...base,
			session: {
				agentRole: "writer",
				agentBudget: {
					...budget,
					sidekick: newSidekickState(budget, "2026-10-19T10:00:00.000Z"),
				},
			},
			tools: { bash: stub, edit: stub },
			lead: "fusion",
		});
		expect(sidekick).toContain("You are Main's writer");
		expect(sidekick).toContain("working directly in Main's checkout");
		expect(sidekick).toContain(
			"Leave your changes uncommitted in the working tree",
		);
		expect(sidekick).toContain(
			"Your budget per round: 150 steps, 30 minutes, 1,000,000 tokens; 6 rounds at most per user request.",
		);
		expect(sidekick).toContain("you start no agents");
		expect(sidekick).toContain("In an exploration round change no files");
		// No pair recorded: the sidekick follows briefs (no pushback).
		expect(sidekick).toContain("Follow each brief as written.");
		expect(sidekick).not.toContain("you are Main");
		// Static across rounds: the round's state never enters the prompt.
		const later = agentTurnInstructions({
			...base,
			session: {
				agentRole: "writer",
				agentBudget: {
					...budget,
					sidekick: beginSidekickRound(
						newSidekickState(budget, "2026-10-19T10:00:00.000Z"),
						{
							now: "2026-10-19T10:20:00.000Z",
							steps: 40,
							tokens: 9,
							base: "abc",
						},
					),
				},
			},
			tools: { bash: stub, edit: stub },
			lead: "fusion",
		});
		expect(later).toBe(sidekick);
	});
});
