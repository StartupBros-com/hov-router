import { describe, expect, it } from "bun:test";
import { logLevelLabel, logLevelTone } from "../log-level";

describe("logLevelTone", () => {
	it.each([
		["ERROR", "danger"],
		["error", "danger"],
		["WARN", "warning"],
		["warning", "warning"],
		["INFO", "info"],
		["DEBUG", "neutral"],
		["trace", "neutral"],
	] as const)("maps %s to %s", (level, tone) => {
		expect(logLevelTone(level)).toBe(tone);
	});

	it("maps a missing level to neutral", () => {
		expect(logLevelTone(undefined)).toBe("neutral");
		expect(logLevelTone("")).toBe("neutral");
	});
});

describe("logLevelLabel", () => {
	it("upper-cases the level", () => {
		expect(logLevelLabel("warning")).toBe("WARNING");
		expect(logLevelLabel("trace")).toBe("TRACE");
		expect(logLevelLabel("INFO")).toBe("INFO");
	});

	it("labels a missing level LOG, as the page does today", () => {
		expect(logLevelLabel(undefined)).toBe("LOG");
		expect(logLevelLabel("")).toBe("LOG");
	});
});
