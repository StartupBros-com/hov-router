/**
 * Where each usage-window segment's label goes on a lane of known pixel width.
 *
 * A label sits inside its segment when it fits there. Otherwise it moves to a
 * callout in a strip below the bar, and a callout that would touch another
 * drops to the next row. No label is hidden and none covers a neighbour: the
 * partial-window qualifier ("$85.00 · 6% used") is load-bearing for data
 * honesty, and on a multi-week domain even a full 7-day window can be too
 * narrow to hold it.
 *
 * Widths are estimated from character counts at just above the widest
 * per-character widths measured in Chromium for these font sizes, so an
 * estimate errs toward moving a label out rather than clipping it.
 */

/** 11px medium segment labels: up to 6.5 px per character measured. */
const LABEL_PX_PER_CHAR = 6.6;
/** 10px chips and axis labels: up to 6.3 px per character measured. */
const CHIP_PX_PER_CHAR = 6.4;
/** A chip's px-1 on each side. */
const CHIP_PAD_PX = 8;
/** A segment's px-1.5 plus its 1px border, both sides. */
const SEGMENT_INSET_PX = 14;
/** gap-1 between a segment's label and chips. */
const SEGMENT_GAP_PX = 4;
/** A callout's px-1 plus its 1px border, both sides. */
const CALLOUT_INSET_PX = 10;
/** Smallest space between two callouts in one row. */
const CALLOUT_GAP_PX = 4;
/** Smallest space between two axis labels. */
const TICK_LABEL_GAP_PX = 8;

export function labelTextPx(text: string): number {
	return Math.ceil(text.length * LABEL_PX_PER_CHAR);
}

export function chipPx(text: string): number {
	return Math.ceil(text.length * CHIP_PX_PER_CHAR + CHIP_PAD_PX);
}

export function tickLabelPx(text: string): number {
	return Math.ceil(text.length * CHIP_PX_PER_CHAR);
}

export interface LaneSegmentLabels {
	leftPercent: number;
	widthPercent: number;
	label: string;
	bonusChip: string | null;
	deltaChip: string | null;
}

export interface LabelCallout {
	row: number;
	leftPx: number;
	widthPx: number;
}

export interface SegmentLabelPlacement {
	labelInside: boolean;
	showBonus: boolean;
	showDelta: boolean;
	callout: LabelCallout | null;
}

export interface LaneLabelLayout {
	/** One per input segment, in input order. */
	placements: SegmentLabelPlacement[];
	calloutRows: number;
}

/**
 * Places each segment's label inside it or in a callout row. Chips go only
 * inside, after the label, bonus reset before delta, and only when they fit;
 * both stay in the segment's title either way.
 */
export function layoutLaneLabels(
	segments: readonly LaneSegmentLabels[],
	trackPx: number,
): LaneLabelLayout {
	const placements: SegmentLabelPlacement[] = [];
	const callouts: { index: number; leftPx: number; widthPx: number }[] = [];

	for (const [index, segment] of segments.entries()) {
		const leftPx = (segment.leftPercent / 100) * trackPx;
		const segmentPx = (segment.widthPercent / 100) * trackPx;
		const room = segmentPx - SEGMENT_INSET_PX;
		const labelPx = labelTextPx(segment.label);

		if (labelPx <= room) {
			let used = labelPx;
			let showBonus = false;
			if (segment.bonusChip !== null) {
				const next = used + SEGMENT_GAP_PX + chipPx(segment.bonusChip);
				if (next <= room) {
					showBonus = true;
					used = next;
				}
			}
			const showDelta =
				segment.deltaChip !== null &&
				used + SEGMENT_GAP_PX + chipPx(segment.deltaChip) <= room;
			placements[index] = {
				labelInside: true,
				showBonus,
				showDelta,
				callout: null,
			};
			continue;
		}

		const widthPx = labelPx + CALLOUT_INSET_PX;
		// Start under the segment; near the end of the track, end with it.
		const anchoredPx =
			leftPx + widthPx <= trackPx ? leftPx : leftPx + segmentPx - widthPx;
		callouts.push({
			index,
			leftPx: Math.max(0, Math.min(Math.round(anchoredPx), trackPx - widthPx)),
			widthPx,
		});
	}

	// Left to right, each callout takes the first row it fits in.
	callouts.sort((a, b) => a.leftPx - b.leftPx);
	const rowEnds: number[] = [];
	for (const callout of callouts) {
		let row = rowEnds.findIndex(
			(endPx) => endPx + CALLOUT_GAP_PX <= callout.leftPx,
		);
		if (row === -1) row = rowEnds.length;
		rowEnds[row] = callout.leftPx + callout.widthPx;
		placements[callout.index] = {
			labelInside: false,
			showBonus: false,
			showDelta: false,
			callout: { row, leftPx: callout.leftPx, widthPx: callout.widthPx },
		};
	}

	return { placements, calloutRows: rowEnds.length };
}

/**
 * Label every Nth axis tick so neighbouring labels never collide. The spacing
 * allows for a first or last label aligned inward (see tickLabelAlign), which
 * sits half a label closer to its neighbour than a centred one.
 */
export function tickLabelStride(
	labelPx: number,
	tickSpacingPx: number,
): number {
	if (!(tickSpacingPx > 0)) return 1;
	return Math.max(
		1,
		Math.ceil((1.5 * labelPx + TICK_LABEL_GAP_PX) / tickSpacingPx),
	);
}

/** Centre a tick label on its tick unless that would push it off the track. */
export function tickLabelAlign(
	atPx: number,
	labelPx: number,
	trackPx: number,
): "start" | "center" | "end" {
	if (atPx < labelPx / 2) return "start";
	if (atPx > trackPx - labelPx / 2) return "end";
	return "center";
}
