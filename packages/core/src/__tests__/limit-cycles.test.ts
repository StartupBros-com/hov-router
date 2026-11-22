import { describe, expect, it } from "bun:test";
import { measureLimitCycles } from "../limit-cycles";

const range = (from: number, to: number): number[] =>
	Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe("measureLimitCycles", () => {
	it("returns null for no readings", () => {
		expect(measureLimitCycles([])).toBeNull();
	});

	it("counts a steady climb as one cycle", () => {
		expect(measureLimitCycles(range(0, 100))).toEqual({
			pointsUsed: 100,
			counterResets: 0,
		});
	});

	it("counts a reset and refill as two cycles", () => {
		const readings = [...range(0, 100), 0, 2, ...range(5, 100)];
		expect(measureLimitCycles(readings)).toEqual({
			pointsUsed: 200,
			counterResets: 1,
		});
	});

	it("counts a partial give-back from the new baseline", () => {
		const readings = [...range(0, 100), ...range(70, 100)];
		expect(measureLimitCycles(readings)).toEqual({
			pointsUsed: 130,
			counterResets: 1,
		});
	});

	it("ignores interleaved sources that alternate 40/20", () => {
		const interleaved = Array.from({ length: 80 }, (_, i) =>
			i % 2 === 0 ? 40 : 20,
		);
		const readings = [10, 20, 30, ...interleaved, ...range(41, 100)];
		expect(measureLimitCycles(readings)).toEqual({
			pointsUsed: 100,
			counterResets: 0,
		});
	});

	it("ignores small dips without double counting", () => {
		expect(measureLimitCycles([50, 55, 52, 55, 58])).toEqual({
			pointsUsed: 58,
			counterResets: 0,
		});
	});

	it("counts from zero when the first reading is mid-window", () => {
		expect(measureLimitCycles([35, 40, 60])).toEqual({
			pointsUsed: 60,
			counterResets: 0,
		});
	});

	it("ignores a fall on the final reading with nothing after it", () => {
		expect(measureLimitCycles([10, 50, 80, 5])).toEqual({
			pointsUsed: 80,
			counterResets: 0,
		});
	});

	it("counts a fall confirmed by fewer than three trailing readings", () => {
		expect(measureLimitCycles([10, 50, 80, 5, 8])).toEqual({
			pointsUsed: 83,
			counterResets: 1,
		});
	});

	it("counts repeated identical readings once", () => {
		expect(measureLimitCycles([50, 50, 50, 50, 50])).toEqual({
			pointsUsed: 50,
			counterResets: 0,
		});
		expect(measureLimitCycles([0, 0, 0, 0])).toEqual({
			pointsUsed: 0,
			counterResets: 0,
		});
		expect(measureLimitCycles([100, 100, 100, 0, 0, 0, 0])).toEqual({
			pointsUsed: 100,
			counterResets: 1,
		});
	});

	it("ignores a fall that one of the next three readings contradicts", () => {
		expect(measureLimitCycles([10, 50, 80, 5, 8, 78, 90])).toEqual({
			pointsUsed: 90,
			counterResets: 0,
		});
	});
});
