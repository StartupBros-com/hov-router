import { type RefObject, useLayoutEffect, useRef } from "react";
import type {
	AccountUsageWindows,
	ClosedUsageWindow,
	OpenUsageWindow,
} from "../../api";
import { useElementWidth } from "../../hooks/useElementWidth";
import { providerPlanTitle } from "../../utils/provider-utils";
import { StatusPill } from "../ui/status-pill";
import {
	layoutLaneLabels,
	type SegmentLabelPlacement,
	tickLabelAlign,
	tickLabelPx,
	tickLabelStride,
} from "./timeline-label-layout";
import { WindowValueComparisonTable } from "./WindowValueComparisonTable";
import {
	deltaVsPriorMedian,
	formatCompactWindowValue,
	formatTimelineDate,
	formatWindowValue,
	groupByProvider,
	type ProviderWindowSection,
	sectionLastFullWindowSubtotal,
	type TimelineDomain,
	type TimelineSegmentGeometry,
	type TimelineTick,
	timeDomain,
	timelineSegmentGeometry,
	weeklyTimelineTicks,
} from "./window-value-utils";

/** Track width assumed before the first measurement (and in server rendering). */
const FALLBACK_TRACK_PX = 640;

/**
 * Lane geometry in px: segments fill 8-48 (top-2 h-10), callouts sit in rows
 * of 22 below them, and a lane with no callouts keeps its original 56.
 */
const CALLOUT_TOP_PX = 50;
const CALLOUT_ROW_PX = 22;
const LANE_BOTTOM_PAD_PX = 4;
const LANE_MIN_HEIGHT_PX = 56;

function laneHeightPx(calloutRows: number): number {
	if (calloutRows === 0) return LANE_MIN_HEIGHT_PX;
	return CALLOUT_TOP_PX + calloutRows * CALLOUT_ROW_PX + LANE_BOTTOM_PAD_PX;
}

/**
 * The name column stays put while the bars scroll sideways on a narrow
 * screen; it covers the column gap too, so bars pass under it cleanly.
 */
const STICKY_NAME_CELL_CLASS = "sticky left-0 z-20 -mr-3 bg-background pr-3";

type TimelineWindow = ClosedUsageWindow | OpenUsageWindow;

export interface WindowValueTimelineProps {
	accounts: readonly AccountUsageWindows[];
	nowMs: number;
}

function tickPositionPercent(atMs: number, domain: TimelineDomain): number {
	const spanMs = Math.max(1, domain.endMs - domain.startMs);
	return ((atMs - domain.startMs) / spanMs) * 100;
}

function isOpenWindow(window: TimelineWindow): window is OpenUsageWindow {
	return window.closedAt === null;
}

function isPartialWindow(window: TimelineWindow): boolean {
	return !isOpenWindow(window) && window.peakUtilization < 95;
}

function grantTypeLabel(window: TimelineWindow): string {
	if (window.grantType === "early_reset") return "bonus reset";
	if (window.grantType === "first_observed") return "partial";
	return "natural";
}

function formatDelta(delta: number): string {
	return `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%`;
}

function segmentLabel(window: TimelineWindow): string {
	const valueUsd = isOpenWindow(window)
		? window.valueSoFarUsd
		: window.valueUsd;
	const lowerBound = window.grantType === "first_observed" ? "≥ " : "";
	const valueLabel = `${lowerBound}${formatCompactWindowValue(valueUsd)}`;

	if (isPartialWindow(window)) {
		return `${valueLabel} · ${Math.round(window.peakUtilization)}% used`;
	}

	return valueLabel;
}

function segmentTitle(
	window: TimelineWindow,
	nowMs: number,
	delta: number | null,
): string {
	const endMs = isOpenWindow(window)
		? Math.min(nowMs, window.resetsAt)
		: window.closedAt;
	const valueUsd = isOpenWindow(window)
		? window.valueSoFarUsd
		: window.valueUsd;
	const utilization = isOpenWindow(window)
		? window.utilization
		: window.peakUtilization;
	const openDetail = isOpenWindow(window) ? " · open" : "";
	const deltaDetail = delta === null ? "" : ` · Δ ${formatDelta(delta)}`;
	// Same lower-bound treatment as segmentLabel: a first-observed value is an
	// observational floor, and the tooltip must never present it as exact.
	const lowerBound = window.grantType === "first_observed" ? "≥ " : "";

	return `${formatTimelineDate(window.startedAt)} – ${formatTimelineDate(endMs)} · ${lowerBound}${formatWindowValue(valueUsd)} · ${Math.round(utilization)}% used · ${grantTypeLabel(window)}${deltaDetail}${openDetail}`;
}

function TimelineGridlines({
	domain,
	ticks,
}: {
	domain: TimelineDomain;
	ticks: readonly TimelineTick[];
}) {
	return (
		<>
			{ticks.map((tick) => (
				<span
					aria-hidden="true"
					className="absolute inset-y-0 w-px bg-border/70"
					key={tick.atMs}
					style={{ left: `${tickPositionPercent(tick.atMs, domain)}%` }}
				/>
			))}
		</>
	);
}

const TICK_LABEL_TRANSLATE = {
	start: "translateX(0)",
	center: "translateX(-50%)",
	end: "translateX(-100%)",
} as const;

function TimelineAxis({
	domain,
	ticks,
	trackPx,
	trackRef,
}: {
	domain: TimelineDomain;
	ticks: readonly TimelineTick[];
	trackPx: number;
	trackRef: RefObject<HTMLDivElement | null>;
}) {
	const labelPx = Math.max(0, ...ticks.map((tick) => tickLabelPx(tick.label)));
	const [first, second] = ticks;
	const tickSpacingPx =
		first && second
			? ((second.atMs - first.atMs) /
					Math.max(1, domain.endMs - domain.startMs)) *
				trackPx
			: 0;
	const stride = tickLabelStride(labelPx, tickSpacingPx);

	return (
		<div className="relative h-8 border-b border-border" ref={trackRef}>
			<TimelineGridlines domain={domain} ticks={ticks} />
			{ticks.map((tick, index) => {
				if (index % stride !== 0) return null;
				const percent = tickPositionPercent(tick.atMs, domain);
				const align = tickLabelAlign(
					(percent / 100) * trackPx,
					tickLabelPx(tick.label),
					trackPx,
				);
				return (
					<span
						className="absolute top-1 whitespace-nowrap text-[10px] text-muted-foreground"
						key={tick.atMs}
						style={{
							left: `${percent}%`,
							transform: TICK_LABEL_TRANSLATE[align],
						}}
					>
						{tick.label}
					</span>
				);
			})}
		</div>
	);
}

/**
 * Chips on a segment sit on an opaque card: the soft tone fills are
 * translucent and would let the segment's orange through.
 */
const SEGMENT_CHIP_CLASS = "shrink-0 bg-card px-1 text-[10px]";

const BONUS_RESET_CHIP = "bonus reset";

function deltaChipText(delta: number): string {
	return `Δ ${formatDelta(delta)}`;
}

function DeltaChip({ delta }: { delta: number }) {
	return (
		<StatusPill
			tone={delta < 0 ? "danger" : "success"}
			className={SEGMENT_CHIP_CLASS}
		>
			{deltaChipText(delta)}
		</StatusPill>
	);
}

/**
 * Fill and text for one segment. Full windows carry dark text on a solid
 * fill; partial windows (under 95 % used) a pale fill with full-strength text,
 * so the "· N% used" qualifier stays as readable as any other label.
 */
function segmentToneClass(window: TimelineWindow, partial: boolean): string {
	if (window.grantType === "early_reset")
		return partial
			? "window-value-segment--early-reset border-chart-warning/60 bg-chart-warning/25 text-foreground"
			: "window-value-segment--early-reset border-chart-warning/60 bg-chart-warning/80 text-(--warning-solid-foreground) dark:bg-chart-warning";
	if (window.grantType === "first_observed")
		return "window-value-segment--first-observed border-muted-foreground/30 bg-muted text-muted-foreground";
	return partial
		? "border-chart-primary/60 bg-chart-primary/25 text-foreground"
		: "border-chart-primary/35 bg-chart-primary/80 text-(--warning-solid-foreground) dark:bg-chart-primary";
}

interface LaneSegment {
	window: TimelineWindow;
	geometry: TimelineSegmentGeometry;
	delta: number | null;
	label: string;
	title: string;
}

function WindowValueSegment({
	segment,
	placement,
}: {
	segment: LaneSegment;
	placement: SegmentLabelPlacement;
}) {
	const { window, geometry, delta, label, title } = segment;
	const partial = isPartialWindow(window);
	const open = isOpenWindow(window);
	const classNames = [
		"window-value-segment",
		"absolute top-2 flex h-10 min-w-0 items-center gap-1 overflow-hidden rounded-sm border px-1.5 text-[11px] font-medium shadow-sm",
		segmentToneClass(window, partial),
		partial ? "window-value-segment--partial border-dashed" : "",
		open ? "border-r-2 border-r-dashed" : "",
	]
		.filter(Boolean)
		.join(" ");

	return (
		<>
			<div
				className={classNames}
				style={{
					left: `${geometry.leftPercent}%`,
					width: `${geometry.widthPercent}%`,
				}}
				title={title}
			>
				{placement.labelInside && <span className="truncate">{label}</span>}
				{placement.showBonus && (
					<StatusPill
						tone="warning"
						className={`${SEGMENT_CHIP_CLASS} font-semibold`}
					>
						{BONUS_RESET_CHIP}
					</StatusPill>
				)}
				{placement.showDelta && delta !== null && <DeltaChip delta={delta} />}
			</div>
			{placement.callout && (
				<span
					className="window-value-segment-label--outside absolute z-10 flex h-5 items-center whitespace-nowrap rounded border border-border bg-background/95 px-1 text-[11px] font-medium text-foreground shadow-sm"
					style={{
						left: `${placement.callout.leftPx}px`,
						top: `${CALLOUT_TOP_PX + placement.callout.row * CALLOUT_ROW_PX}px`,
					}}
					title={title}
				>
					{label}
				</span>
			)}
		</>
	);
}

function AccountTimelineLane({
	account,
	domain,
	ticks,
	nowMs,
	trackPx,
}: {
	account: AccountUsageWindows;
	domain: TimelineDomain;
	ticks: readonly TimelineTick[];
	nowMs: number;
	trackPx: number;
}) {
	// Oldest closed window first, the open window last.
	const ordered: { window: TimelineWindow; index: number | null }[] = [
		...account.windows.map((window, index) => ({ window, index })).reverse(),
		...(account.openWindow
			? [{ window: account.openWindow, index: null }]
			: []),
	];
	const segments: LaneSegment[] = ordered.map(({ window, index }) => {
		const delta =
			index === null ? null : deltaVsPriorMedian(account.windows, index);
		return {
			window,
			geometry: timelineSegmentGeometry(window, domain, nowMs),
			delta,
			label: segmentLabel(window),
			title: segmentTitle(window, nowMs, delta),
		};
	});
	const { placements, calloutRows } = layoutLaneLabels(
		segments.map(({ window, geometry, delta, label }) => ({
			leftPercent: geometry.leftPercent,
			widthPercent: geometry.widthPercent,
			label,
			bonusChip: window.grantType === "early_reset" ? BONUS_RESET_CHIP : null,
			deltaChip: delta === null ? null : deltaChipText(delta),
		})),
		trackPx,
	);

	return (
		<div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
			<div className={`flex min-w-0 items-center ${STICKY_NAME_CELL_CLASS}`}>
				<p
					className="truncate text-sm font-medium text-foreground"
					title={account.accountName}
				>
					{account.accountName}
				</p>
			</div>
			<div
				className="relative overflow-hidden rounded-md bg-muted/30"
				style={{ height: `${laneHeightPx(calloutRows)}px` }}
			>
				<TimelineGridlines domain={domain} ticks={ticks} />
				{segments.map((segment, index) => (
					<WindowValueSegment
						key={segment.window.id}
						placement={placements[index]}
						segment={segment}
					/>
				))}
			</div>
		</div>
	);
}

function ProviderTimelineSection({
	section,
	domain,
	ticks,
	nowMs,
}: {
	section: ProviderWindowSection;
	domain: TimelineDomain;
	ticks: readonly TimelineTick[];
	nowMs: number;
}) {
	const subtotal = sectionLastFullWindowSubtotal(section.accounts);
	const title = providerPlanTitle(section.provider);
	const { ref: trackRef, width } = useElementWidth<HTMLDivElement>();
	const trackPx = width || FALLBACK_TRACK_PX;
	const scrollerRef = useRef<HTMLDivElement>(null);

	// On a screen narrower than the timeline, open on the latest windows.
	useLayoutEffect(() => {
		const scroller = scrollerRef.current;
		if (scroller) scroller.scrollLeft = scroller.scrollWidth;
	}, []);

	return (
		<section
			aria-label={`${title} usage-window timeline`}
			className="space-y-3"
		>
			<div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
				<h2 className="text-lg font-semibold tracking-tight text-foreground">
					{title}
				</h2>
				<p className="text-sm text-muted-foreground">
					{`last full window: ${formatWindowValue(subtotal)}`}
				</p>
			</div>

			<div className="overflow-x-auto" ref={scrollerRef}>
				<div className="min-w-[36rem] space-y-3">
					<div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
						{/* Fills the axis row's full height, so dates scrolled under it
						    never show above the heading. */}
						<p
							className={`flex items-end pb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground ${STICKY_NAME_CELL_CLASS}`}
						>
							Account
						</p>
						<TimelineAxis
							domain={domain}
							ticks={ticks}
							trackPx={trackPx}
							trackRef={trackRef}
						/>
					</div>

					<div className="space-y-2">
						{section.accounts.map((account) => (
							<AccountTimelineLane
								account={account}
								domain={domain}
								key={account.accountId}
								nowMs={nowMs}
								ticks={ticks}
								trackPx={trackPx}
							/>
						))}
					</div>
				</div>
			</div>

			<WindowValueComparisonTable accounts={section.accounts} nowMs={nowMs} />
		</section>
	);
}

/** Props-only provider-sectioned usage-window timeline for deterministic rendering. */
export function WindowValueTimeline({
	accounts,
	nowMs,
}: WindowValueTimelineProps) {
	const sections = groupByProvider(accounts);
	const domain = timeDomain(accounts, nowMs);
	const ticks = weeklyTimelineTicks(domain);

	return (
		<div className="space-y-8">
			{sections.map((section) => (
				<ProviderTimelineSection
					domain={domain}
					key={section.provider}
					nowMs={nowMs}
					section={section}
					ticks={ticks}
				/>
			))}
		</div>
	);
}
