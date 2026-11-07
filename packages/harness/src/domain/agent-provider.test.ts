import { describe, expect, it } from "vitest";
import {
	API_PROVIDER,
	agentProviderById,
	CODEX_PROVIDER,
	DEFAULT_COMPOSER_HARNESS_ID,
	offeredAgentProviders,
	parseRuntimeId,
} from "./agent-provider";

describe("agent providers", () => {
	it("offers our harness on a ChatGPT subscription or an API connection", () => {
		expect(offeredAgentProviders()).toEqual([CODEX_PROVIDER, API_PROVIDER]);
		expect(agentProviderById("codex")).toEqual(CODEX_PROVIDER);
		expect(agentProviderById("api")).toEqual(API_PROVIDER);
		expect(DEFAULT_COMPOSER_HARNESS_ID).toBe("codex");
	});

	it("rejects retired runtimes", () => {
		expect(parseRuntimeId("api")).toBe("api");
		expect(() => parseRuntimeId("claude")).toThrow("Unsupported runtime");
		expect(() => parseRuntimeId("opencode")).toThrow("Unsupported runtime");
	});
});
