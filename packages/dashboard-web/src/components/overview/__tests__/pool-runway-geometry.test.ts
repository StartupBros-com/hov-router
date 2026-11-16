import { expect, it } from "bun:test";
import { H } from "../../../lib/pool-forecast";
import {
	dayTicks,
	dryBands,
	dryRuns,
	runwayGeometry,
} from "../pool-runway-geometry";

it("scales quota and splits at 48 hours with shared boundary", () => {
	const g = runwayGeometry(0, 168 * H, 700, 200);
	expect(g.x(-H)).toBe(0);
	expect(g.x(168 * H)).toBe(700);
	expect(g.y(200)).toBe(16);
	expect(g.y(0)).toBe(80);
	expect(g.laneY(100)).toBe(3);
	expect(g.laneY(0)).toBe(21);
	const pts = [
		{ t: 0, v: 200 },
		{ t: 48 * H, v: 100 },
		{ t: 49 * H, v: 90 },
	];
	expect(g.split(pts)).toEqual({ near: pts.slice(0, 2), far: pts.slice(1) });
	expect(g.pathOf([{ t: 0, v: 200 }], g.y)).toBe("M0.0,16.0");
});
it("finds all dry stretches including an unclosed one", () => {
	expect(
		dryRuns(
			[
				{ t: 0, left: 0 },
				{ t: 1, left: 0 },
				{ t: 2, left: 100 },
				{ t: 3, left: 0 },
			],
			4,
		),
	).toEqual([
		{ start: 0, end: 2 },
		{ start: 3, end: 4 },
	]);
});

it("fades the part of a dry band beyond 48 hours even when it crosses the boundary", () => {
	expect(dryBands([{ start: 47 * H, end: 50 * H }], 48 * H)).toEqual([
		{ start: 47 * H, end: 48 * H, opacity: 0.12 },
		{ start: 48 * H, end: 50 * H, opacity: 0.07 },
	]);
});
it("places day labels at local noon, including DST transitions", () => {
	const now = new Date(2026, 10, 1, 0).getTime();
	const ticks = dayTicks(now, now + 48 * H);
	expect(ticks.length).toBeGreaterThan(0);
	for (const t of ticks) expect(new Date(t.noon).getHours()).toBe(12);
});
