import { lookup } from "node:dns/promises";
import { isPublicAddress } from "../services/web-fetch-tool";

/**
 * web_fetch's host check on Node: a name is public only when every address
 * it resolves to is a public unicast address (no loopback, private, link-local
 * or metadata ranges). A failed lookup is not public.
 */
export async function nodePublicHost(hostname: string) {
	try {
		const addresses = await lookup(hostname, { all: true, verbatim: true });
		return (
			addresses.length > 0 &&
			addresses.every((entry) => isPublicAddress(entry.address))
		);
	} catch {
		return false;
	}
}
