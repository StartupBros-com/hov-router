import { ChevronDown } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import {
	type ForecastAccount,
	forecastHeadline,
	heldLabel,
	inText,
	laneText,
	type PoolGroup,
	shouldShowNextBadge,
} from "../../lib/pool-forecast";
import { cn } from "../../lib/utils";
import {
	AXIS_H,
	dayTicks,
	dryBands,
	dryRuns,
	LANE_H,
	PLOT_H,
	runwayGeometry,
	TOP,
} from "./pool-runway-geometry";

function NextBadge() {
	return (
		<span className="shrink-0 rounded-sm border px-1 text-[10px] font-medium leading-4 text-foreground">
			next
		</span>
	);
}
/** Why a held-back account is not serving; muted, because it is not an outage. */
function HeldBadge({ account }: { account: ForecastAccount }) {
	return (
		<span className="shrink-0 whitespace-nowrap rounded-sm border px-1 text-[10px] leading-4 text-muted-foreground">
			{heldLabel(account.reason)}
		</span>
	);
}
function useWidth<T extends HTMLElement>(enabled: boolean) {
	const ref = useRef<T>(null);
	const [width, setWidth] = useState(0);
	useLayoutEffect(() => {
		if (!enabled) return;
		const el = ref.current;
		if (!el) return;
		setWidth(Math.round(el.getBoundingClientRect().width));
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(([entry]) =>
			setWidth(Math.round(entry.contentRect.width)),
		);
		observer.observe(el);
		return () => observer.disconnect();
	}, [enabled]);
	return { ref, width };
}

export function PoolRunway({
	group,
	now,
	open,
	onToggle,
}: {
	group: PoolGroup;
	now: number;
	open: boolean;
	onToggle: () => void;
}) {
	const { ref, width } = useWidth<HTMLDivElement>(group.forecast !== null);
	const f = group.forecast;
	if (!f)
		return (
			<div>
				<ol aria-label={`${group.title} accounts, soonest reset first`}>
					{group.accounts.map((a) => (
						<li key={a.id} className="text-xs text-muted-foreground">
							<span>{laneText(a, now)}</span>
						</li>
					))}
				</ol>
				<AccountList group={group} now={now} open={open} onToggle={onToggle} />
			</div>
		);
	const { end, sureEnd, x, y, laneY, pathOf, split } = runwayGeometry(
		now,
		f.horizonMs,
		width,
		f.capacity,
	);
	const pool = f.series.map((p) => ({ t: p.t, v: p.left }));
	const poolLine = split(pool);
	const area = `${pathOf(pool, y)} L${x(end).toFixed(1)},${y(0)} L0,${y(0)} Z`;
	const runs = dryRuns(f.series, end);
	const bands = dryBands(runs, sureEnd);
	const days = dayTicks(now, end);
	const sureX = width > 0 ? x(sureEnd) : 0;
	return (
		<div className="flex min-w-0 flex-col">
			{/* Runway row: y labels in the gutter, the pooled line beside them. */}
			<div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 sm:grid-cols-[8rem_minmax(0,1fr)]">
				<div
					className="relative text-right text-[11px] text-muted-foreground tabular-nums"
					aria-hidden="true"
				>
					<span className="absolute right-0" style={{ top: y(f.capacity) - 7 }}>
						100%
					</span>
					<span
						className="absolute right-0"
						style={{ top: y(f.capacity / 2) - 7 }}
					>
						50%
					</span>
					<span className="absolute right-0" style={{ top: y(0) - 7 }}>
						0
					</span>
				</div>
				<div ref={ref} className="min-w-0">
					{width > 0 && (
						<svg
							width={width}
							height={TOP + PLOT_H + AXIS_H}
							role="img"
							aria-label={`${group.title}: ${forecastHeadline(group, now).headline}`}
							className="block overflow-visible"
						>
							{[0.5, 1].map((frac) => (
								<line
									key={frac}
									x1={0}
									x2={width}
									y1={y(f.capacity * frac)}
									y2={y(f.capacity * frac)}
									stroke="var(--chart-grid)"
									strokeDasharray="2 4"
								/>
							))}
							{bands.map((r) => (
								<rect
									key={r.start}
									x={x(r.start)}
									y={TOP}
									width={Math.max(2, x(r.end) - x(r.start))}
									height={PLOT_H + AXIS_H}
									fill="var(--danger)"
									opacity={r.opacity}
								/>
							))}
							<path d={area} fill="var(--foreground)" opacity={0.08} />
							<path
								d={pathOf(poolLine.near, y)}
								fill="none"
								stroke="var(--foreground)"
								strokeWidth={1.75}
								strokeLinejoin="round"
							/>
							{poolLine.far.length > 1 && (
								<path
									d={pathOf(poolLine.far, y)}
									fill="none"
									stroke="var(--foreground)"
									strokeWidth={1.5}
									strokeDasharray="4 3"
									strokeLinejoin="round"
								/>
							)}
							<line
								x1={0}
								x2={width}
								y1={y(0)}
								y2={y(0)}
								stroke="var(--chart-axis)"
							/>
							{sureEnd < end && (
								<line
									x1={sureX}
									x2={sureX}
									y1={TOP}
									y2={TOP + PLOT_H + AXIS_H}
									stroke="var(--chart-axis)"
									strokeDasharray="2 3"
								/>
							)}
							{days.map((t) => (
								<line
									key={`tick-${t.midnight}`}
									x1={x(t.midnight)}
									x2={x(t.midnight)}
									y1={y(0)}
									y2={y(0) + 3}
									stroke="var(--chart-axis)"
								/>
							))}
							{runs[0] && (
								<text
									x={Math.min(x(runs[0].start) + 6, width - 4)}
									y={TOP - 4}
									fontSize={11}
									fill="var(--danger)"
									fontWeight={600}
									textAnchor={
										x(runs[0].start) + 6 > width - 120 ? "end" : "start"
									}
								>
									Nothing left
								</text>
							)}
							<text
								x={0}
								y={TOP + PLOT_H + 13}
								fontSize={11}
								fill="var(--chart-axis)"
							>
								Now
							</text>
							{days.map((t) => {
								const mid = x(t.noon);
								return mid > 40 && mid < width - 14 ? (
									<text
										key={`day-${t.noon}`}
										x={mid}
										y={TOP + PLOT_H + 13}
										fontSize={11}
										fill="var(--chart-axis)"
										textAnchor="middle"
									>
										{t.label}
									</text>
								) : null;
							})}
						</svg>
					)}
				</div>
			</div>
			{/* Lanes: one per account, soonest reset first, each its own 0-100% of quota left on the same clock. */}
			<ol
				aria-label={`${group.title} accounts, soonest reset first`}
				className="flex flex-col"
			>
				{group.accounts.map((a) => {
					const levels = f.lanes[a.name];
					const pts = levels
						? f.series.map((p, i) => ({ t: p.t, v: levels[i] ?? 0 }))
						: null;
					const lane = pts ? split(pts) : null;
					const laneArea = pts
						? `${pathOf(pts, laneY)} L${x(end).toFixed(1)},${laneY(0)} L0,${laneY(0)} Z`
						: "";
					// A held account's quota is drawn but faded until it serves again.
					const backX =
						lane && a.state === "held" && a.backMs != null && a.backMs > now
							? Math.min(x(a.backMs), width)
							: 0;
					return (
						<li
							key={a.name}
							className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-x-3 sm:grid-cols-[8rem_minmax(0,1fr)]"
							style={{ height: LANE_H }}
						>
							<span className="flex min-w-0 items-center justify-end gap-x-1 text-xs">
								<span className="truncate font-medium" title={a.name}>
									{a.name}
								</span>
								{shouldShowNextBadge(a) && <NextBadge />}
							</span>
							<span className="sr-only">{laneText(a, now)}</span>
							{width > 0 && (
								<svg
									width={width}
									height={LANE_H}
									aria-hidden="true"
									className="block overflow-visible"
								>
									{bands.map((r) => (
										<rect
											key={r.start}
											x={x(r.start)}
											y={0}
											width={Math.max(2, x(r.end) - x(r.start))}
											height={LANE_H}
											fill="var(--danger)"
											opacity={r.opacity}
										/>
									))}
									<line
										x1={0}
										x2={width}
										y1={laneY(0)}
										y2={laneY(0)}
										stroke="var(--chart-grid)"
									/>
									{lane ? (
										<>
											<path
												d={laneArea}
												fill="var(--foreground)"
												opacity={0.14}
											/>
											<path
												d={pathOf(lane.near, laneY)}
												fill="none"
												stroke="var(--foreground)"
												strokeWidth={1.25}
												strokeLinejoin="round"
											/>
											{lane.far.length > 1 && (
												<path
													d={pathOf(lane.far, laneY)}
													fill="none"
													stroke="var(--foreground)"
													strokeWidth={1.1}
													strokeDasharray="3 2"
													strokeLinejoin="round"
													opacity={0.7}
												/>
											)}
											{backX > 0 && (
												<rect
													x={0}
													y={0}
													width={backX}
													height={LANE_H}
													fill="var(--card)"
													opacity={0.7}
												/>
											)}
										</>
									) : (
										<text
											x={4}
											y={LANE_H / 2 + 4}
											fontSize={11}
											fill="var(--chart-axis)"
										>
											{a.state === "held"
												? heldLabel(a.reason)
												: "no usage data"}
										</text>
									)}
									{sureEnd < end && (
										<line
											x1={sureX}
											x2={sureX}
											y1={0}
											y2={LANE_H}
											stroke="var(--chart-axis)"
											strokeDasharray="2 3"
										/>
									)}
								</svg>
							)}
						</li>
					);
				})}
			</ol>
			<AccountList group={group} now={now} open={open} onToggle={onToggle} />
		</div>
	);
}
export function AccountList({
	group,
	now,
	open,
	onToggle,
}: {
	group: PoolGroup;
	now: number;
	open: boolean;
	onToggle: () => void;
}) {
	const id = `runway-${group.id}-accounts`;
	return (
		<div className="mt-1">
			<button
				type="button"
				aria-expanded={open}
				aria-controls={id}
				onClick={onToggle}
				className="inline-flex min-h-11 items-center gap-1.5 rounded-md text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			>
				<ChevronDown
					className={cn("h-4 w-4 transition-transform", open && "rotate-180")}
					aria-hidden="true"
				/>
				{open ? "Hide exact times" : "Exact times"}
			</button>
			{open && (
				<ol
					id={id}
					aria-label={`${group.title} accounts, soonest reset first`}
					className="divide-y rounded-md border text-xs"
				>
					{group.accounts.map((a) => {
						const lost =
							a.leftAtResetPct != null && a.leftAtResetPct >= 10
								? Math.round(a.leftAtResetPct)
								: null;
						return (
							<li
								key={a.name}
								className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-3 py-2 sm:grid-cols-[minmax(0,1fr)_7rem_8rem]"
							>
								<span className="flex min-w-0 items-center gap-1.5">
									<span className="truncate font-medium">{a.name}</span>
									{shouldShowNextBadge(a) && <NextBadge />}
									{a.state === "held" && <HeldBadge account={a} />}
								</span>
								<span
									className={cn(
										"tabular-nums sm:text-right",
										a.state === "out" && "font-medium text-(--danger)",
									)}
								>
									{a.state === "out"
										? "Out"
										: a.state === "unknown"
											? "No data"
											: `${Math.round(a.pct ?? 0)}% used`}
								</span>
								<span className="col-span-2 text-muted-foreground tabular-nums sm:col-span-1 sm:text-right">
									{timeText(a, now)}
									{lost != null && <span> · about {lost}% unused</span>}
								</span>
							</li>
						);
					})}
				</ol>
			)}
		</div>
	);
}
/** The exact-times column: when this account next serves, or when its window resets. */
function timeText(a: ForecastAccount, now: number): string {
	const back = a.state === "held" ? inText(a.backMs ?? null, now) : null;
	if (back) return `back ${back}`;
	const reset = inText(a.resetMs, now);
	if (!reset) return "no reset time";
	return `${a.state === "out" ? "back" : "resets"} ${reset}`;
}
