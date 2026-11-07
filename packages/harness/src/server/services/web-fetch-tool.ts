import { type ToolSet, tool } from "ai";
import { convert } from "html-to-text";
import ipaddr from "ipaddr.js";
import { z } from "zod";
import { keepHead, LEAN_MAX_BYTES, LEAN_MAX_LINES } from "./lean-output";

export const WEB_FETCH_TOOL = "web_fetch";

const TIMEOUT_MS = 30_000;
/** The most a page may download before it is refused (its text is cut far lower). */
const MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const USER_AGENT = "ytimesy-web-fetch/1 (+https://ytimesy.com)";

const HTML_TYPES = ["text/html", "application/xhtml+xml"];
/** Passed through as text: text/*, JSON, XML and JavaScript, with their +json/+xml forms. */
function isTextType(type: string) {
	return (
		type.startsWith("text/") ||
		/^application\/([\w.-]+\+)?(json|xml)$/.test(type) ||
		type === "application/javascript" ||
		type === "application/x-ndjson"
	);
}

/** True when an address literal is a public unicast address. */
export function isPublicAddress(address: string) {
	try {
		return ipaddr.process(address).range() === "unicast";
	} catch {
		return false;
	}
}

/**
 * Whether the harness may connect to `hostname`: true for a public host.
 * The caller resolves names (a Worker has no DNS API; Node checks every
 * address the name resolves to).
 */
export type HostCheck = (hostname: string) => Promise<boolean>;

export class WebFetchError extends Error {
	override name = "WebFetchError";
}

/** The page's readable text: HTML without scripts, styles or images; other text unchanged. */
export function pageText(body: string, contentType: string) {
	if (!HTML_TYPES.includes(contentType)) return body;
	return convert(body, {
		wordwrap: false,
		selectors: [
			{ selector: "script", format: "skip" },
			{ selector: "style", format: "skip" },
			{ selector: "noscript", format: "skip" },
			{ selector: "svg", format: "skip" },
			{ selector: "img", format: "skip" },
			{ selector: "a", options: { hideLinkHrefIfSameAsText: true } },
		],
	}).trim();
}

async function readCapped(response: Response, signal: AbortSignal) {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES)
		throw new WebFetchError(
			`the page is ${declared} bytes, over the ${MAX_DOWNLOAD_BYTES}-byte limit; fetch a smaller or more specific URL.`,
		);
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		signal.throwIfAborted();
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > MAX_DOWNLOAD_BYTES) {
			await reader.cancel().catch(() => {});
			throw new WebFetchError(
				`the page is over the ${MAX_DOWNLOAD_BYTES}-byte limit; fetch a smaller or more specific URL.`,
			);
		}
		chunks.push(value);
	}
	return new TextDecoder().decode(Buffer.concat(chunks));
}

/** The text window from line `offset` (1-based), within the lean read limits, with a cut note. */
function windowed(text: string, offset: number) {
	const lines = text.split("\n");
	const from = Math.min(Math.max(1, offset), Math.max(1, lines.length));
	const kept = keepHead(lines.slice(from - 1).join("\n"), {
		maxBytes: LEAN_MAX_BYTES,
		maxLines: LEAN_MAX_LINES,
	});
	if (!kept.truncated) return kept.content;
	const last = from - 1 + kept.lastLine;
	return `${kept.content}\n[Page cut to lines ${from}-${last} of ${lines.length}; call web_fetch again with offset: ${last + 1} for more.]`;
}

/**
 * Fetches one public http(s) page from the harness side (never the task's
 * sandbox) and returns its final URL, status and readable text. The request
 * carries no cookies, credentials or project data: only the URL, a user
 * agent and an Accept header. Every redirect hop is checked like the first
 * URL. Non-2xx statuses, timeouts, non-text content and oversize pages are
 * errors the model can act on.
 */
export async function webFetch(input: {
	url: string;
	offset?: number;
	checkHost: HostCheck;
	fetch?: typeof globalThis.fetch;
	signal?: AbortSignal;
	timeoutMs?: number;
}) {
	const send = input.fetch ?? globalThis.fetch;
	const signal = AbortSignal.any([
		AbortSignal.timeout(input.timeoutMs ?? TIMEOUT_MS),
		...(input.signal ? [input.signal] : []),
	]);
	let url: URL;
	try {
		url = new URL(input.url);
	} catch {
		throw new WebFetchError(`${input.url} is not a URL.`);
	}
	try {
		for (let hop = 0; ; hop++) {
			if (url.protocol !== "http:" && url.protocol !== "https:")
				throw new WebFetchError(
					`only http and https URLs can be fetched (got ${url.protocol}).`,
				);
			if (url.username || url.password)
				throw new WebFetchError("URLs with credentials are not fetched.");
			const host = url.hostname.replace(/^\[|\]$/g, "");
			const allowed = ipaddr.isValid(host)
				? isPublicAddress(host)
				: await input.checkHost(host);
			if (!allowed)
				throw new WebFetchError(
					`${url.hostname} is not a public host; only public pages can be fetched.`,
				);
			const response = await send(url, {
				redirect: "manual",
				signal,
				headers: {
					"user-agent": USER_AGENT,
					accept:
						"text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5",
				},
			});
			const location = response.headers.get("location");
			if (response.status >= 300 && response.status < 400 && location) {
				await response.body?.cancel().catch(() => {});
				if (hop >= MAX_REDIRECTS)
					throw new WebFetchError(`more than ${MAX_REDIRECTS} redirects.`);
				url = new URL(location, url);
				continue;
			}
			if (response.status < 200 || response.status >= 300) {
				await response.body?.cancel().catch(() => {});
				throw new WebFetchError(
					`${url.href} returned HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}.`,
				);
			}
			const type = (response.headers.get("content-type") ?? "text/plain")
				.split(";")[0]
				.trim()
				.toLowerCase();
			if (!HTML_TYPES.includes(type) && !isTextType(type)) {
				await response.body?.cancel().catch(() => {});
				throw new WebFetchError(
					`${url.href} is ${type}, not a text page; only HTML, text, JSON and XML are returned.`,
				);
			}
			const text = pageText(await readCapped(response, signal), type);
			return [
				`URL: ${url.href}`,
				`Status: ${response.status}`,
				`Content-Type: ${type}`,
				"",
				windowed(text || "(empty page)", input.offset ?? 1),
			].join("\n");
		}
	} catch (error) {
		if (error instanceof WebFetchError) throw error;
		if (signal.aborted && input.signal?.aborted !== true)
			throw new WebFetchError(
				`${url.href} did not answer within ${Math.round((input.timeoutMs ?? TIMEOUT_MS) / 1000)} s.`,
			);
		throw new WebFetchError(
			`${url.href} could not be fetched (${error instanceof Error ? error.message : String(error)}).`,
		);
	}
}

/** The web_fetch tool: one page as text. Its description is fixed (cache-stable). */
export function webFetchTool(input: {
	checkHost: HostCheck;
	fetch?: typeof globalThis.fetch;
}): ToolSet {
	return {
		[WEB_FETCH_TOOL]: tool({
			description: `Fetch one public web page (http or https) and return its final URL, status and readable text: HTML as text without scripts or styles; plain text, JSON and XML as they are. Up to ${LEAN_MAX_LINES} lines or ${LEAN_MAX_BYTES / 1024} KB per call; pass offset (a line number) to read further.`,
			inputSchema: z.object({
				url: z.string().min(1).max(4_000).describe("An http or https URL"),
				offset: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe("The line to start from (default 1)"),
			}),
			execute: async ({ url, offset }, options) =>
				webFetch({
					url,
					...(offset ? { offset } : {}),
					checkHost: input.checkHost,
					...(input.fetch ? { fetch: input.fetch } : {}),
					...(options?.abortSignal ? { signal: options.abortSignal } : {}),
				}),
		}),
	};
}
