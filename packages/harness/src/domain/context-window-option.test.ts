import { describe, expect, it } from "vitest";
import {
	chosenContextWindow,
	contextWindowLabel,
	listedContextWindow,
} from "./context-window-option";

describe("context window option", () => {
	it("labels windows as the picker shows them", () => {
		expect(contextWindowLabel(272_000)).toBe("272K");
		expect(contextWindowLabel(1_000_000)).toBe("1M");
		expect(contextWindowLabel(1_050_000)).toBe("1.05M");
		expect(contextWindowLabel(872_000)).toBe("872K");
	});
	it("keeps only an option whose alternate window really differs", () => {
		expect(listedContextWindow({ standard: 272_000, alternate: 272_000 })).toBe(
			undefined,
		);
		expect(listedContextWindow({ standard: 272_000 })).toBe(undefined);
		expect(
			listedContextWindow({ standard: 200_000, alternate: 500_000, note: "" }),
		).toEqual({ standard: 200_000, alternate: 500_000 });
		expect(
			listedContextWindow({ standard: 1_050_000, alternate: 272_000 }),
		).toEqual({ standard: 1_050_000, alternate: 272_000 });
	});
	it("runs the standard window unless the alternate one is chosen", () => {
		const option = { standard: 272_000, alternate: 872_000 };
		expect(chosenContextWindow(option, false)).toBe(272_000);
		expect(chosenContextWindow(option, undefined)).toBe(272_000);
		expect(chosenContextWindow(option, true)).toBe(872_000);
		expect(chosenContextWindow(undefined, true)).toBe(undefined);
	});
});
