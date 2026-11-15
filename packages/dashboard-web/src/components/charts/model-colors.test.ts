import { describe, expect, it } from "bun:test";
import { CHART_COLORS, COLORS } from "../../constants";
import { getModelColor, MODEL_COLORS } from "./model-colors";

describe("model colours", () => {
	it("looks up the short name before a partial match", () => {
		expect(getModelColor("claude-opus-4-1-20250805")).toBe(COLORS.indigo);
	});

	it("looks up an exact key before a partial match", () => {
		expect(getModelColor("claude-opus-4.1")).toBe(COLORS.indigo);
	});

	it("uses the first partial match in insertion order", () => {
		expect(getModelColor("provider/claude-opus-4.1")).toBe(COLORS.pink);
		expect(getModelColor("claude-3.5")).toBe(COLORS.purple);
	});

	it("falls back to the primary token without an index", () => {
		expect(getModelColor("unknown-model")).toBe(COLORS.primary);
	});

	it("falls back to the indexed chart token and wraps the palette", () => {
		for (const index of [0, 1, CHART_COLORS.length + 2]) {
			expect(getModelColor("unknown-model", index)).toBe(
				CHART_COLORS[index % CHART_COLORS.length],
			);
		}
	});

	it("keeps a matching model colour when an index is provided", () => {
		expect(getModelColor("claude-opus-4.1", 0)).toBe(COLORS.indigo);
	});

	it("keeps the seven palette keys and their order", () => {
		expect(Object.keys(MODEL_COLORS)).toEqual([
			"claude-3.5-sonnet",
			"claude-3.5-haiku",
			"claude-3-opus",
			"claude-opus-4",
			"claude-opus-4.1",
			"claude-sonnet-4",
			"claude-sonnet-4.5",
		]);
	});
});
