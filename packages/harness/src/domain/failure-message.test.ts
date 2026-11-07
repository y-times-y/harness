import { describe, expect, it } from "vitest";
import {
	failureMessage,
	isWorkspaceAtCapacity,
	isWorkspaceComputeAllowanceExhausted,
	workspaceLooksGone,
} from "./failure-message";

describe("failureMessage", () => {
	it("unwraps Effect.tryPromise UnknownException to the inner error", () => {
		expect(
			failureMessage({
				_tag: "UnknownException",
				message: "An unknown error occurred in Effect.tryPromise",
				error: {
					_tag: "WorkspaceCommandError",
					message: "VM not found",
				},
			}),
		).toBe("VM not found");
	});

	it("keeps a normal Error message", () => {
		expect(failureMessage(new Error("Desktop failed to start."))).toBe(
			"Desktop failed to start.",
		);
	});
});

describe("workspaceLooksGone", () => {
	it("recognizes a missing Workspace VM", () => {
		expect(workspaceLooksGone("VM not found")).toBe(true);
		expect(workspaceLooksGone("No such VM in this team")).toBe(true);
		expect(workspaceLooksGone("Workspace API 404")).toBe(true);
		expect(workspaceLooksGone("Codex login timed out")).toBe(false);
		expect(workspaceLooksGone("codex binary not found")).toBe(false);
	});
});

describe("isWorkspaceAtCapacity", () => {
	it("recognizes the Workspace VM cap before and after the public rewrite", () => {
		expect(isWorkspaceAtCapacity("LIMIT_EXCEEDED: limit of 5 VMs")).toBe(true);
		expect(
			isWorkspaceAtCapacity(
				"This Workspace plan is at its VM limit. Delete an unused agent session or raise the quota before starting another. Pausing a VM does not free a slot.",
			),
		).toBe(true);
		expect(isWorkspaceAtCapacity("Snapshot sh-old not found")).toBe(false);
	});
});

describe("isWorkspaceComputeAllowanceExhausted", () => {
	it("recognizes Workspace vcpu and memory time allowance errors", () => {
		expect(
			isWorkspaceComputeAllowanceExhausted(
				"Cannot start this VM because the allowance for vcpu_time, memory_time has been used. Add a card to unlock the full Free allowance, wait for the allowance to reset, or upgrade to Hobby; then resume the VM manually.",
			),
		).toBe(true);
		expect(
			isWorkspaceComputeAllowanceExhausted(
				"This Workspace plan has used its vCPU-hour allowance. Wait for the allowance to reset or upgrade the plan, then resume the VM.",
			),
		).toBe(true);
		expect(isWorkspaceComputeAllowanceExhausted("LIMIT_EXCEEDED")).toBe(false);
	});
});
