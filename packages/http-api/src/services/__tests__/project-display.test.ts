import { describe, expect, test } from "bun:test";
import {
	PROJECT_DISPLAY_MAX_CHARS,
	sanitizeProjectForDisplay,
} from "../project-display";

describe("sanitizeProjectForDisplay", () => {
	test("returns null for null / undefined / empty / whitespace-only input", () => {
		expect(sanitizeProjectForDisplay(null)).toBeNull();
		expect(sanitizeProjectForDisplay(undefined)).toBeNull();
		expect(sanitizeProjectForDisplay("")).toBeNull();
		expect(sanitizeProjectForDisplay("   \t\n  ")).toBeNull();
	});

	test("strips C0 control characters and DEL so prompt content cannot smuggle bytes through the UI", () => {
		const hostile = "hello\x00\x07\x1b[31m\x7fworld";
		expect(sanitizeProjectForDisplay(hostile)).toBe("helloworld");
	});

	test("collapses whitespace runs and trims", () => {
		// The gap between `alpha` and `beta` is purely C0 whitespace, so
		// after stripping the control chars the words become adjacent
		// (sanitisation cannot fabricate a space where none existed).
		expect(sanitizeProjectForDisplay("  alpha\n\n\tbeta  ")).toBe("alphabeta");
		// Spaces inside the input are real whitespace and DO get collapsed.
		expect(sanitizeProjectForDisplay("  alpha    beta  ")).toBe("alpha beta");
	});

	test("clamps to PROJECT_DISPLAY_MAX_CHARS and appends an ellipsis", () => {
		const long = "x".repeat(PROJECT_DISPLAY_MAX_CHARS + 50);
		const out = sanitizeProjectForDisplay(long);
		expect(out).not.toBeNull();
		expect(out?.length).toBe(PROJECT_DISPLAY_MAX_CHARS);
		expect(out?.endsWith("…")).toBe(true);
	});

	test("passes a normal project name through unchanged", () => {
		expect(sanitizeProjectForDisplay("repo-frontend")).toBe("repo-frontend");
	});

	test("returns null when the input is only control characters", () => {
		expect(sanitizeProjectForDisplay("\x00\x01\x02")).toBeNull();
	});
});
