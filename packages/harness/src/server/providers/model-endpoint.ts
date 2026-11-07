import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { Agent, fetch as transportFetch } from "undici";
import { publicModelEndpoint } from "../../domain/model-connection";

type ModelEndpointTransport = {
	fetch: typeof globalThis.fetch;
	close: () => Promise<void>;
};
const endpointFactory = new AsyncLocalStorage<
	(baseUrl: string) => ModelEndpointTransport
>();

/** Request-local capability: the edge adapter never falls back to a Node socket. */
export function withModelEndpointFactory<T>(
	factory: (baseUrl: string) => ModelEndpointTransport,
	run: () => T,
): T {
	return endpointFactory.run(factory, run);
}

export function isPublicModelAddress(address: string): boolean {
	try {
		return ipaddr.process(address).range() === "unicast";
	} catch {
		return false;
	}
}

/** Validate at socket connection time, not just when saving: DNS can change after validation. */
export function modelEndpointTransport(baseUrl: string) {
	const scoped = endpointFactory.getStore();
	if (scoped) return scoped(baseUrl);
	const allowed = new URL(publicModelEndpoint(baseUrl));
	const dispatcher = new Agent({
		// Bound the wait for a response to start and silence between streamed
		// chunks, not the whole response: max-effort reasoning steps often stream
		// for longer than two minutes.
		headersTimeout: 120_000,
		bodyTimeout: 300_000,
		connect: {
			lookup(hostname, options, callback) {
				void lookup(hostname, { all: true, verbatim: true })
					.then((addresses) => {
						if (
							!addresses.length ||
							addresses.some((row) => !isPublicModelAddress(row.address))
						) {
							callback(
								new Error(
									"Model endpoints must resolve only to public addresses.",
								),
								[],
								undefined,
							);
							return;
						}
						const matching = options.family
							? addresses.filter((row) => row.family === options.family)
							: addresses;
						if (!matching.length) {
							callback(
								new Error("No supported public address."),
								[],
								undefined,
							);
							return;
						}
						if (options.all) callback(null, matching, undefined);
						else callback(null, matching[0].address, matching[0].family);
					})
					.catch(() =>
						callback(
							new Error("Model endpoint DNS resolution failed."),
							[],
							undefined,
						),
					);
			},
		},
	});
	const fetch: typeof globalThis.fetch = async (input, init) => {
		const target = new URL(
			input instanceof Request ? input.url : String(input),
		);
		if (target.origin !== allowed.origin || target.username || target.password)
			throw new Error("Model endpoint origin changed.");
		const literal = target.hostname.replace(/^\[|\]$/g, "");
		if (ipaddr.isValid(literal) && !isPublicModelAddress(literal))
			throw new Error("Model endpoints must use public addresses.");
		const request = new Request(input, init);
		const signal = request.signal;
		return (await transportFetch(target, {
			method: request.method,
			headers: [...request.headers],
			body: request.body,
			duplex: request.body ? "half" : undefined,
			signal,
			redirect: "manual",
			dispatcher,
		} as Parameters<typeof transportFetch>[1])) as unknown as Response;
	};
	return { fetch, close: () => dispatcher.close() };
}

import { AsyncLocalStorage } from "node:async_hooks";
