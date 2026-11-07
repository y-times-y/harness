import { z } from "zod";
import { leanToolNames } from "./harness-model-profile";

// Task tools of the retired lead/child architecture stay listed so their
// recorded metric rows still validate; only report_task_blocked is offered now.
const retiredTaskToolNames = [
	"read_task_checks",
	"read_task_summary",
	"read_task_output",
	"read_task_capacity",
	"list_peers",
	"send_peer_message",
	"create_task",
	"edit_task",
	"start_task",
	"list_tasks",
	"send_task_message",
	"request_task_wrap_up",
	"inspect_task_diff",
	"read_task_handoff",
	"import_reviewed_task",
	"mark_task_reviewed",
	"publish_task",
] as const;

const toolNames = [
	...retiredTaskToolNames,
	"report_task_blocked",
	"read_file",
	"read_files",
	"list_files",
	"search_files",
	"inspect_changes",
	"verify_changes",
	"create_file",
	"replace_text",
	"apply_patch",
	"apply_patches",
	"bash",
	"execute_command",
	"continue_command",
	"view_image",
	"compose_tools",
	"update_plan",
	"read_work_plan",
	"browser_execute",
	"start_command",
	"read_command",
	"wait_command",
	"run_checks",
	"stop_command",
	"read_tool_output",
	"read_environment_report",
	"read_context_archive",
	"search_context_history",
	"remember_project",
	"inspect_project_evidence",
	"read_repository_guidance",
	"search_tools",
	"browser_screenshot",
	"browser_click",
	"browser_type",
	"browser_key",
	"browser_open",
	"browser_inspect",
	"inspect_code",
	"inspect_code_batch",
	"read_code",
	"rename_symbol",
	"rename_file",
	"apply_code_action",
	"debug_program",
	"debug_node",
	"prepare_code_tools",
	"plan_parallel_work",
	// Lean surfaces (docs/builder-tool-surface.md).
	...leanToolNames(),
	"other",
] as const;
export const harnessToolName = z.enum(toolNames);

export const harnessToolCategory = z.enum([
	"read",
	"edit",
	"command",
	"coordination",
	"browser",
	"discovery",
	"other",
]);
export const harnessToolMetric = z.object({
	tool_name: harnessToolName,
	category: harnessToolCategory,
	duration_ms: z.number().finite().nonnegative(),
	outcome: z.enum(["completed", "failed"]),
	error_class: z.enum([
		"none",
		"execution",
		"reported_failure",
		"timeout",
		"output_limit",
	]),
	repeated_read: z.boolean(),
});
export type HarnessToolMetric = z.infer<typeof harnessToolMetric>;
export const harnessModelMetric = z.object({
	duration_ms: z.number().finite().nonnegative(),
	first_output_ms: z.number().finite().nonnegative().nullable(),
	active_tools: z.number().int().nonnegative(),
	input_tokens: z.number().int().nonnegative().nullable(),
	output_tokens: z.number().int().nonnegative().nullable(),
	text_output_tokens: z.number().int().nonnegative().nullable().optional(),
	reasoning_output_tokens: z.number().int().nonnegative().nullable().optional(),
	cache_read_tokens: z.number().int().nonnegative().nullable(),
	prepared_prompt_characters: z.number().int().nonnegative().optional(),
	prepared_tool_characters: z.number().int().nonnegative().optional(),
	outcome: z.enum(["completed", "tool_calls", "limited", "failed"]),
});
export type HarnessModelMetric = z.infer<typeof harnessModelMetric>;

export function toolMetricCategory(
	name: string,
): z.infer<typeof harnessToolCategory> {
	if (name.startsWith("browser_")) return "browser";
	if (
		[
			"apply_patch",
			"apply_patches",
			"create_file",
			"replace_text",
			"rename_symbol",
			"rename_file",
			"apply_code_action",
			...leanToolNames(["write", "edit"]),
		].includes(name)
	)
		return "edit";
	if (
		[
			"bash",
			"execute_command",
			"continue_command",
			"start_command",
			"stop_command",
			"read_command",
			"wait_command",
			"run_checks",
			"debug_program",
			"debug_node",
			"prepare_code_tools",
			...leanToolNames(["command", "stdin"]),
		].includes(name)
	)
		return "command";
	if (["search_tools", "read_repository_guidance"].includes(name))
		return "discovery";
	if (
		[
			"read_file",
			"view_image",
			...leanToolNames(["read", "glob", "grep", "image"]),
			"read_files",
			"search_files",
			"list_files",
			"inspect_changes",
			"verify_changes",
			"read_tool_output",
			"read_environment_report",
			"read_context_archive",
			"search_context_history",
			"inspect_code",
			"inspect_code_batch",
			"read_code",
		].includes(name)
	)
		return "read";
	if (
		name.includes("task") ||
		name.includes("peer") ||
		name === "plan_parallel_work"
	)
		return "coordination";
	return "other";
}

export function reportedToolFailure(output: unknown) {
	if (Array.isArray(output)) return output.some(reportedToolFailure);
	if (!output || typeof output !== "object") return false;
	return (
		("ok" in output && output.ok === false) ||
		("status" in output &&
			(output.status === "failed" ||
				(typeof output.status === "number" && output.status !== 0))) ||
		("exitCode" in output &&
			typeof output.exitCode === "number" &&
			output.exitCode !== 0) ||
		("passed" in output && output.passed === false) ||
		("failedPath" in output && typeof output.failedPath === "string")
	);
}

export function toolFailureClass(
	output: unknown,
): HarnessToolMetric["error_class"] {
	if (Array.isArray(output)) {
		const classes = output.map(toolFailureClass);
		return classes.includes("output_limit")
			? "output_limit"
			: classes.includes("timeout")
				? "timeout"
				: (classes.find((classification) => classification !== "none") ??
					"none");
	}
	if (output && typeof output === "object") {
		if ("stopped" in output && output.stopped === "output_limit")
			return "output_limit";
		if (
			("stopped" in output && output.stopped === "timeout") ||
			("status" in output && output.status === 124) ||
			("exitCode" in output && output.exitCode === 124)
		)
			return "timeout";
	}
	return reportedToolFailure(output) ? "reported_failure" : "none";
}
