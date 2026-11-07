import { describe, expect, it } from "vitest";
import { activityGlyphForToolName } from "./session-activity";

describe("activityGlyphForToolName", () => {
	it("maps tool names to explicit glyphs instead of a generic wrench", () => {
		expect(activityGlyphForToolName("shell")).toBe("shell");
		expect(activityGlyphForToolName("apply_patch")).toBe("edit");
		expect(activityGlyphForToolName("read_file")).toBe("read");
		expect(activityGlyphForToolName("grep")).toBe("search");
		expect(activityGlyphForToolName("web_search")).toBe("web");
	});
});
