import { describe, expect, it } from "vitest";
import {
	AuthSnapshotId,
	JobId,
	ProjectId,
	SessionId,
	SessionItemId,
	UserId,
	WorkspaceId,
} from "./ids";

describe("branded IDs", () => {
	it("accepts trimmed values", () => {
		expect(UserId(" user-1 ").toString()).toBe("user-1");
		expect(ProjectId("p1")).toBe("p1");
		expect(WorkspaceId("vm_1")).toBe("vm_1");
		expect(SessionId("s1")).toBe("s1");
		expect(JobId("j1")).toBe("j1");
		expect(AuthSnapshotId("sh-1")).toBe("sh-1");
		expect(SessionItemId("item-1")).toBe("item-1");
	});

	it("rejects empty values", () => {
		expect(() => WorkspaceId("  ")).toThrow(
			"WorkspaceId requires a non-empty value",
		);
		expect(() => UserId("")).toThrow("UserId requires a non-empty value");
	});
});
