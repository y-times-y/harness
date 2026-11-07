import { expect, it } from "vitest";
import {
	scopedToolExecution,
	toolRequestFingerprint,
} from "./tool-execution-identity";

it("binds replay to tool and nested arguments regardless of object key ordering", () => {
	expect(toolRequestFingerprint("edit", { b: { z: 1, a: 2 }, a: "x" })).toBe(
		toolRequestFingerprint("edit", { a: "x", b: { a: 2, z: 1 } }),
	);
	expect(toolRequestFingerprint("edit", { a: "x" })).not.toBe(
		toolRequestFingerprint("delete", { a: "x" }),
	);
	expect(toolRequestFingerprint("edit", { a: [1, 2] })).not.toBe(
		toolRequestFingerprint("edit", { a: [2, 1] }),
	);
});

it("keeps concurrent tool identities isolated without persisting raw arguments", async () => {
	const scope = scopedToolExecution();
	const tools = scope.wrap({
		inspect: {
			type: "function",
			inputSchema: {} as never,
			execute: async () => {
				await Promise.resolve();
				return scope.fingerprint();
			},
		},
	});
	const invoke = (a: string) =>
		tools.inspect.execute?.(
			{ a },
			{ toolCallId: a, messages: [], context: {} },
		);
	expect(
		await Promise.all([invoke("secret-one"), invoke("secret-two")]),
	).toEqual([
		toolRequestFingerprint("inspect", { a: "secret-one" }),
		toolRequestFingerprint("inspect", { a: "secret-two" }),
	]);
	expect(() => scope.fingerprint()).toThrow();
});
