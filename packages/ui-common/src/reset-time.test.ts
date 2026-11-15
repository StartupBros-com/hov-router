import { describe, expect, it } from "bun:test";
import { formatClockTime, sameResetKeepers } from "./reset-time";

const now = Date.UTC(2026, 10, 14, 12);
const reset = Date.UTC(2026, 10, 14, 19, 9);

describe("sameResetKeepers", () => {
	it("repeats the first reset when the next is 20 seconds later", () => {
		expect(
			sameResetKeepers([new Date(reset).toISOString(), reset + 20_000]),
		).toEqual([null, 0]);
	});
	it("keeps resets 30 minutes apart", () => {
		expect(sameResetKeepers([reset, reset + 30 * 60_000])).toEqual([
			null,
			null,
		]);
	});
	it("keeps equal resets that are not adjacent", () => {
		expect(sameResetKeepers([reset, reset + 30 * 60_000, reset])).toEqual([
			null,
			null,
			null,
		]);
	});
	it("ends a run at a null, invalid or non-finite reset", () => {
		for (const invalid of [
			null,
			undefined,
			"not-a-date",
			NaN,
			Infinity,
			-Infinity,
		]) {
			expect(sameResetKeepers([reset, reset, invalid, reset, reset])).toEqual([
				null,
				0,
				null,
				null,
				3,
			]);
		}
	});
	it("compares 50 second steps to the keeper so a run cannot drift", () => {
		expect(
			sameResetKeepers([
				reset,
				reset + 50_000,
				reset + 100_000,
				reset + 150_000,
			]),
		).toEqual([null, 0, null, 2]);
	});
});

describe("formatClockTime", () => {
	it("shows only the clock on the same local day", () => {
		expect(
			formatClockTime(reset, now, { locale: "en-US", timeZone: "UTC" }),
		).toBe("7:09 PM");
	});
	it("includes the month and day on another local day", () => {
		expect(
			formatClockTime(Date.UTC(2026, 10, 15, 19, 9), now, {
				locale: "en-US",
				timeZone: "UTC",
			}),
		).toBe("Nov 15, 7:09 PM");
	});
});
