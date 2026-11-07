const BRAND_NAMES: Record<string, string> = {
	github: "GitHub",
	gitlab: "GitLab",
	posthog: "PostHog",
	pagerduty: "PagerDuty",
	planetscale: "PlanetScale",
};

/** A display name for a brand id ("github" → "GitHub", "linear" → "Linear"). */
export function brandName(id: string) {
	return BRAND_NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

/** An MCP server's name as Settings shows it: plugin servers are <plugin>-<server>, so "linear-linear" reads "Linear". */
export function mcpServerLabel(name: string) {
	const words = [...new Set(name.split(/[-_]/).filter(Boolean))];
	return words.length === 1 ? brandName(words[0] as string) : name;
}

/**
 * An MCP tool's name in plain words, without the server's name it often
 * repeats: "notion-get-self" on notion → "Get self", "search_pages" → "Search pages".
 */
export function mcpToolLabel(tool: string, server = "") {
	const serverWords = new Set(
		server.toLowerCase().split(/[-_]/).filter(Boolean),
	);
	let words = tool
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.split(/[-_.\s]+/)
		.filter(Boolean);
	while (
		words.length > 1 &&
		serverWords.has((words[0] as string).toLowerCase())
	)
		words = words.slice(1);
	words = words.map((word) =>
		/^[A-Z0-9]+$/.test(word) && word.length > 1 ? word : word.toLowerCase(),
	);
	const text = words.join(" ");
	return text.charAt(0).toUpperCase() + text.slice(1);
}
