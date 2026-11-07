import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { ToolSet } from "ai";
import { canonicalize } from "json-canonicalize";

/** The durable journal stores a digest, not another plaintext copy of tool arguments. */
export function toolRequestFingerprint(name: string, arguments_: unknown) {
	return createHash("sha256")
		.update(canonicalize({ name, arguments: arguments_ }))
		.digest("hex");
}

export function scopedToolExecution() {
	const identity = new AsyncLocalStorage<string>();
	return {
		fingerprint: () => {
			const fingerprint = identity.getStore();
			if (!fingerprint) throw new Error("Tool execution identity is missing.");
			return fingerprint;
		},
		wrap: (tools: ToolSet): ToolSet =>
			Object.fromEntries(
				Object.entries(tools).map(([name, definition]) => {
					const execute = definition.execute;
					return [
						name,
						execute
							? {
									...definition,
									execute: (
										args: unknown,
										options: Parameters<NonNullable<typeof execute>>[1],
									) =>
										identity.run(toolRequestFingerprint(name, args), () =>
											execute(args, options),
										),
								}
							: definition,
					];
				}),
			),
	};
}
