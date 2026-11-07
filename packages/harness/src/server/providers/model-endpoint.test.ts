import { expect, it } from "vitest";
import { isPublicModelAddress, modelEndpointTransport } from "./model-endpoint";

it.each([
	"127.0.0.1",
	"10.1.2.3",
	"192.168.1.2",
	"169.254.169.254",
	"100.64.0.1",
	"::1",
	"fc00::1",
	"fe80::1",
	"::ffff:127.0.0.1",
	"0.0.0.0",
	"224.0.0.1",
	"not-an-ip",
])("blocks nonpublic address %s", (address) =>
	expect(isPublicModelAddress(address)).toBe(false),
);
it.each(["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"])(
	"accepts public address %s",
	(address) => expect(isPublicModelAddress(address)).toBe(true),
);
it("blocks literal private destinations and changed origins before sending a key", async () => {
	const local = modelEndpointTransport("https://127.0.0.1/v1");
	await expect(local.fetch("https://127.0.0.1/v1/models")).rejects.toThrow(
		"public addresses",
	);
	await local.close();
	const publicEndpoint = modelEndpointTransport("https://example.com/v1");
	await expect(
		publicEndpoint.fetch("https://evil.example/models", {
			headers: { Authorization: "fixture" },
		}),
	).rejects.toThrow("origin changed");
	await publicEndpoint.close();
});
