import { describe, expect, it } from "bun:test";
import {
	chipPx,
	type LaneSegmentLabels,
	labelTextPx,
	layoutLaneLabels,
	tickLabelAlign,
	tickLabelStride,
} from "../timeline-label-layout";

function segment(overrides: Partial<LaneSegmentLabels>): LaneSegmentLabels {
	return {
		leftPercent: 0,
		widthPercent: 10,
		label: "$3k",
		bonusChip: null,
		deltaChip: null,
		...overrides,
	};
}

describe("label width estimates", () => {
	// Rendered widths measured in Chromium on the synthetic Window value page.
	// An estimate below one of these would leave a label clipped inside its
	// segment instead of moving it out.
	it("never comes in under the widths measured in the browser", () => {
		expect(labelTextPx("$160.00")).toBeGreaterThanOrEqual(45.5);
		expect(labelTextPx("≥ $40.00 · 60% used")).toBeGreaterThanOrEqual(116.1);
		expect(chipPx("bonus reset")).toBeGreaterThanOrEqual(74.9);
		expect(chipPx("Δ +20.0%")).toBeGreaterThanOrEqual(58.2);
	});
});

describe("layoutLaneLabels", () => {
	it("keeps a label inside a segment it fits in, with both chips when there is room", () => {
		const {
			placements: [wide],
			calloutRows,
		} = layoutLaneLabels(
			[
				segment({
					widthPercent: 40,
					label: "$1.7k",
					bonusChip: "bonus reset",
					deltaChip: "Δ +12.3%",
				}),
			],
			800,
		);
		expect(wide).toEqual({
			labelInside: true,
			showBonus: true,
			showDelta: true,
			callout: null,
		});
		expect(calloutRows).toBe(0);
	});

	it("drops the delta chip before the bonus-reset chip when only one fits", () => {
		const label = "$1.7k";
		// Room for the label and the bonus chip, not for the delta chip too.
		const segmentPx =
			14 + labelTextPx(label) + 4 + chipPx("bonus reset") + 4 + 10;
		const {
			placements: [mid],
		} = layoutLaneLabels(
			[
				segment({
					widthPercent: segmentPx / 10,
					label,
					bonusChip: "bonus reset",
					deltaChip: "Δ +12.3%",
				}),
			],
			1000,
		);
		expect(mid).toMatchObject({
			labelInside: true,
			showBonus: true,
			showDelta: false,
		});
	});

	it("moves a label that does not fit to a callout carrying the full text", () => {
		const label = "$85.00 · 6% used";
		const {
			placements: [narrow],
			calloutRows,
		} = layoutLaneLabels(
			[
				segment({
					leftPercent: 50,
					widthPercent: 6,
					label,
					deltaChip: "Δ -1.0%",
				}),
			],
			640,
		);
		expect(narrow).toEqual({
			labelInside: false,
			showBonus: false,
			showDelta: false,
			callout: { row: 0, leftPx: 320, widthPx: labelTextPx(label) + 10 },
		});
		expect(calloutRows).toBe(1);
	});

	it("anchors a callout near the end of the track to its segment's right edge", () => {
		const label = "$85.00 · 6% used";
		const widthPx = labelTextPx(label) + 10;
		const {
			placements: [late],
		} = layoutLaneLabels(
			[segment({ leftPercent: 90, widthPercent: 5, label })],
			640,
		);
		const callout = late?.callout;
		// Segment spans 576-608 px; the callout ends where the segment ends.
		expect(callout?.leftPx).toBe(608 - widthPx);
		expect((callout?.leftPx ?? 0) + widthPx).toBeLessThanOrEqual(640);
	});

	it("keeps every callout inside the track, even one wider than its segment's side", () => {
		const label = "≥ $40.00 · 60% used";
		const { placements } = layoutLaneLabels(
			[
				segment({ leftPercent: 0, widthPercent: 2, label }),
				segment({ leftPercent: 98, widthPercent: 2, label }),
			],
			200,
		);
		expect(placements).toHaveLength(2);
		for (const placement of placements) {
			const callout = placement.callout;
			expect(callout).not.toBeNull();
			expect(callout?.leftPx).toBeGreaterThanOrEqual(0);
			expect(
				(callout?.leftPx ?? 0) + (callout?.widthPx ?? 0),
			).toBeLessThanOrEqual(200);
		}
	});

	it("drops a callout to a second row instead of covering its neighbour", () => {
		const label = "$85.00 · 6% used";
		const {
			placements: [a, b, c],
			calloutRows,
		} = layoutLaneLabels(
			[
				segment({ leftPercent: 10, widthPercent: 3, label }),
				segment({ leftPercent: 14, widthPercent: 3, label }),
				// Far enough right to share the first row with the first one.
				segment({ leftPercent: 60, widthPercent: 3, label }),
			],
			640,
		);
		expect(calloutRows).toBe(2);
		expect(a?.callout?.row).toBe(0);
		expect(b?.callout?.row).toBe(1);
		expect(c?.callout?.row).toBe(0);
	});

	it("never lets two callouts in one row touch, whatever the input order", () => {
		const label = "$85.00 · 6% used";
		const segments = [37, 3, 21, 5, 64, 30, 12, 50, 8, 41].map((leftPercent) =>
			segment({ leftPercent, widthPercent: 2, label }),
		);
		const { placements } = layoutLaneLabels(segments, 640);
		const callouts = placements.map((p) => p.callout);
		expect(callouts).toHaveLength(segments.length);
		expect(callouts.every((c) => c !== null)).toBe(true);
		for (const a of callouts) {
			for (const b of callouts) {
				if (!a || !b || a === b || a.row !== b.row) continue;
				const apart =
					a.leftPx + a.widthPx + 4 <= b.leftPx ||
					b.leftPx + b.widthPx + 4 <= a.leftPx;
				expect(apart).toBe(true);
			}
		}
	});
});

describe("axis tick labels", () => {
	it("labels every tick when they are far enough apart", () => {
		expect(tickLabelStride(40, 120)).toBe(1);
	});

	it("labels every second or third tick when they would collide", () => {
		expect(tickLabelStride(40, 50)).toBe(2);
		expect(tickLabelStride(40, 30)).toBe(3);
	});

	it("labels every tick when the spacing is unknown", () => {
		expect(tickLabelStride(40, 0)).toBe(1);
	});

	it("aligns labels at the ends of the track inward so they stay inside it", () => {
		expect(tickLabelAlign(0, 40, 400)).toBe("start");
		expect(tickLabelAlign(200, 40, 400)).toBe("center");
		expect(tickLabelAlign(395, 40, 400)).toBe("end");
	});
});
