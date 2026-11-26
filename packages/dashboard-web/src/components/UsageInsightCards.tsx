import type { UsageHistoryWindowSeries } from "@hov-router/types";
import { Flame } from "lucide-react";
import { computeWeeklyPace } from "../lib/usage-pace";
import { formatShortDuration } from "../lib/utils";
import { formatWindowName } from "./accounts/rate-limit-helpers";
import { StatTile, type StatTileRow } from "./ui/stat-tile";

interface UsageInsightCardsProps {
	windows: UsageHistoryWindowSeries[];
	/** Reference "now" (ms epoch), injected by the caller for determinism —
	 * pass the same minute-bucketed value the chart uses (no Date.now() here). */
	now: number;
}

const PACE_LABEL: Record<string, string> = {
	on_pace: "on pace",
	over_pace: "over pace",
	in_reserve: "in reserve",
};

/**
 * Burn-rate & weekly-pace insight cards — one per window that has at least
 * one snapshot, reusing the SAME `windows` series (and its server-computed
 * `prediction`) the usage-history chart already fetched. No duplicate
 * fetching and no reimplemented regression: slope/ETA/willExhaustBeforeReset
 * all come straight from `UsageHistoryWindowSeries.prediction`.
 */
export function UsageInsightCards({ windows, now }: UsageInsightCardsProps) {
	const active = windows.filter((w) => w.points.length > 0);
	if (active.length === 0) return null;

	return (
		<div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
			{active.map((series) => (
				<WindowInsightCard key={series.window} series={series} now={now} />
			))}
		</div>
	);
}

function WindowInsightCard({
	series,
	now,
}: {
	series: UsageHistoryWindowSeries;
	now: number;
}) {
	const { window, prediction, points } = series;
	const lastPoint = points[points.length - 1];

	// Mirrors the prediction lib's own confidence gate: too few points
	// ("insufficient_data") or a data span under ~5 min (lowConfidence) both
	// mean the trend isn't trustworthy yet.
	const insufficientData =
		prediction.state === "insufficient_data" || prediction.lowConfidence;

	const burnRateLabel = insufficientData
		? "—"
		: `${prediction.slopePerHour >= 0 ? "+" : ""}${prediction.slopePerHour.toFixed(1)}%/hr`;

	const exhaustsFirst =
		!insufficientData &&
		prediction.willExhaustBeforeReset &&
		prediction.etaExhaustMs != null;

	const exhaustRestLabel = insufficientData
		? "— insufficient data"
		: [
				prediction.state === "exhausted"
					? "exhausts now"
					: prediction.etaExhaustMs != null
						? `exhausts in ${formatShortDuration(Math.max(0, prediction.etaExhaustMs - now))}`
						: "not exhausting",
				prediction.resetsAtMs != null
					? `resets in ${formatShortDuration(Math.max(0, prediction.resetsAtMs - now))}`
					: "no reset known",
			].join(" / ");

	// Weekly pace: seven_day only (not seven_day_opus/seven_day_sonnet — those
	// are per-model tiers, not the account-wide weekly window this compares
	// against calendar pace).
	const weeklyPace =
		window === "seven_day" && lastPoint
			? computeWeeklyPace(lastPoint.utilization, prediction.resetsAtMs, now)
			: null;

	const rows: StatTileRow[] = [
		{
			label: "Exhaustion vs reset",
			value: exhaustRestLabel,
			valueClassName: exhaustsFirst
				? "text-destructive"
				: "text-muted-foreground",
		},
	];
	if (weeklyPace)
		rows.push({
			label: "Weekly pace",
			value: `${PACE_LABEL[weeklyPace.band]} (${weeklyPace.deltaPct >= 0 ? "+" : ""}${weeklyPace.deltaPct.toFixed(1)}pp)`,
			valueClassName:
				weeklyPace.band === "over_pace"
					? "text-warning"
					: weeklyPace.band === "in_reserve"
						? "text-success"
						: "text-muted-foreground",
		});

	return (
		<StatTile
			label={`${formatWindowName(window)} burn rate`}
			icon={Flame}
			value={burnRateLabel}
			rows={rows}
		/>
	);
}
