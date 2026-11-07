/** Add only documented preservation controls to known direct Chat Completions routes. */
export function preservedThinkingFetch(
	baseUrl: string,
	fetch: typeof globalThis.fetch,
): typeof globalThis.fetch {
	const origin = new URL(baseUrl).origin;
	return async (url, init) => {
		if (typeof init?.body !== "string") return fetch(url, init);
		const body = JSON.parse(init.body);
		if (!Array.isArray(body.messages)) return fetch(url, init);
		if (origin === "https://api.z.ai")
			body.thinking = { ...body.thinking, clear_thinking: false };
		else if (
			["https://api.moonshot.ai", "https://api.kimi.ai"].includes(origin) &&
			/^kimi-k2\.6(?:-|$)/.test(body.model)
		)
			body.thinking = { ...body.thinking, keep: "all" };
		else return fetch(url, init);
		return fetch(url, { ...init, body: JSON.stringify(body) });
	};
}
