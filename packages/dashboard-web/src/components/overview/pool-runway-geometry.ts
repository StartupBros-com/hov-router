import { H } from "../../lib/pool-forecast";
export const PLOT_H = 64;
export const TOP = 16;
export const AXIS_H = 18;
export const LANE_H = 24;
export const SURE_MS = 48 * H;
export type Point = { t: number; v: number };
export function dryBands(
	runs: Array<{ start: number; end: number }>,
	sureEnd: number,
) {
	return runs.flatMap((run) => {
		const bands: Array<{ start: number; end: number; opacity: number }> = [];
		if (run.start < sureEnd)
			bands.push({
				start: run.start,
				end: Math.min(run.end, sureEnd),
				opacity: 0.12,
			});
		if (run.end > sureEnd)
			bands.push({
				start: Math.max(run.start, sureEnd),
				end: run.end,
				opacity: 0.07,
			});
		return bands;
	});
}
export function dryRuns(
	series: Array<{ t: number; left: number }>,
	end: number,
) {
	const runs: Array<{ start: number; end: number }> = [];
	let open: { start: number; end: number } | null = null;
	for (const p of series) {
		if (p.left <= 0.001) {
			if (!open) {
				open = { start: p.t, end };
				runs.push(open);
			}
		} else if (open) {
			open.end = p.t;
			open = null;
		}
	}
	return runs;
}
export function dayTicks(now: number, end: number) {
	const date = new Date(now);
	date.setHours(0, 0, 0, 0);
	const ticks: Array<{ midnight: number; noon: number; label: string }> = [];
	while (date.getTime() < end) {
		const noon = new Date(date);
		noon.setHours(12);
		ticks.push({
			midnight: date.getTime(),
			noon: noon.getTime(),
			label: noon.toLocaleDateString(undefined, { weekday: "short" }),
		});
		date.setDate(date.getDate() + 1);
	}
	return ticks;
}
export function runwayGeometry(
	now: number,
	horizonMs: number,
	width: number,
	capacity: number,
) {
	const end = now + horizonMs;
	const sureEnd = Math.min(end, now + SURE_MS);
	const x = (t: number) =>
		((Math.min(Math.max(t, now), end) - now) / horizonMs) * width;
	const y = (left: number) => TOP + PLOT_H - (left / capacity) * PLOT_H;
	const laneY = (left: number) => LANE_H - 3 - (left / 100) * (LANE_H - 6);
	const pathOf = (pts: Point[], yOf: (v: number) => number) =>
		pts
			.map(
				(p, i) =>
					`${i === 0 ? "M" : "L"}${x(p.t).toFixed(1)},${yOf(p.v).toFixed(1)}`,
			)
			.join(" ");
	const split = (pts: Point[]) => {
		const cut = pts.findIndex((p) => p.t > sureEnd);
		return cut === -1
			? { near: pts, far: [] }
			: { near: pts.slice(0, cut), far: pts.slice(Math.max(0, cut - 1)) };
	};
	return { end, sureEnd, x, y, laneY, pathOf, split };
}
