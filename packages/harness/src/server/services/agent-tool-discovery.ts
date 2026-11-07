import { type ToolSet, toolSearch } from "ai";
import { isShellSurface } from "../../domain/harness-model-profile";

/**
 * The builder's (and every subagent's) tool set, sent whole from the first
 * request. Discovery that re-added tools mid-turn changed the tools prefix
 * and invalidated the provider prompt cache for every later request,
 * so nothing is deferred here; on-demand tools are deferred-tools.ts's job.
 */
export function discoverableAgentTools(tools: ToolSet): ToolSet {
	if (Object.keys(tools).length === 0) return tools;
	// Only provider-hosted tools (a search=function call's own request):
	// nothing to discover, so the set goes as given.
	if (
		Object.values(tools).every(
			(definition) => (definition as { type?: string }).type === "provider",
		)
	)
		return tools;
	return {
		...Object.fromEntries(
			Object.entries(tools).map(([name, definition]) => [
				name,
				{ ...definition, deferLoading: false },
			]),
		),
		// A shell-shaped surface is offered exactly as given.
		...(isShellSurface(Object.keys(tools))
			? {}
			: { search_tools: toolSearch() }),
	};
}
