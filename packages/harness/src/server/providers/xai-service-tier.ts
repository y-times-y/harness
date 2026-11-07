/**
 * xAI's priority tier on its own API (a key or the Grok plan): each model
 * request asks for `service_tier`, and the answer says which tier served it.
 * xAI may serve a priority request at the default tier (and then bills it as
 * default), so a turn that asked for fast but got default is logged, never
 * reported as fast. Nothing here logs a token or a body.
 */
export function xaiServiceTierFetch(
	fetch: typeof globalThis.fetch,
	serviceTier: string,
	log: (message: string, detail: Record<string, unknown>) => void = (
		message,
		detail,
	) => console.warn(message, detail),
): typeof globalThis.fetch {
	return async (url, init) => {
		if (typeof init?.body !== "string") return fetch(url, init);
		let body: Record<string, unknown>;
		try {
			body = JSON.parse(init.body) as Record<string, unknown>;
		} catch {
			return fetch(url, init);
		}
		if (typeof body.model !== "string") return fetch(url, init);
		const model = body.model.slice(0, 80);
		const response = await fetch(url, {
			...init,
			body: JSON.stringify({ ...body, service_tier: serviceTier }),
		});
		if (!response.ok || !response.body) return response;
		return new Response(
			response.body.pipeThrough(
				servedTierWatch((served) => {
					if (served !== serviceTier)
						log("xAI served a fast request at another tier.", {
							model,
							requested: serviceTier,
							served: served ?? "unknown",
						});
				}),
			),
			{
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			},
		);
	};
}

const TIER = /"service_tier"\s*:\s*"([A-Za-z_-]{1,20})"/g;
/** Enough of the previous chunk to find a field split across two chunks. */
const CARRY = 64;

/**
 * Passes a response body through unchanged and reports the last
 * `service_tier` it carried (the completed response's, in a stream) when the
 * body ends. A quoted value inside model text is escaped, so it never matches.
 */
export function servedTierWatch(
	onServed: (tier: string | null) => void,
): TransformStream<Uint8Array, Uint8Array> {
	const decoder = new TextDecoder();
	let carry = "";
	let served: string | null = null;
	let reported = false;
	const scan = (text: string) => {
		const window = carry + text;
		for (const match of window.matchAll(TIER)) served = match[1] ?? served;
		carry = window.slice(-CARRY);
	};
	return new TransformStream({
		transform(chunk, controller) {
			controller.enqueue(chunk);
			scan(decoder.decode(chunk, { stream: true }));
		},
		flush() {
			scan(decoder.decode());
			if (!reported) {
				reported = true;
				onServed(served);
			}
		},
	});
}
