import { ChevronRight } from "lucide-react";
import { Fragment } from "react";
import type { RoutingObservation } from "../../api";
import { formatFamilyLabel, listObservedFamilies } from "../../lib/pool-usage";
import { cn } from "../../lib/utils";
export function formatShortDuration(ms: number): string {
	const totalMinutes = Math.max(0, Math.round(ms / 60000));
	// Sub-30s-rounding-to-a-minute durations get seconds granularity for
	// routing-observation ages. Longer durations keep the prior minute/hour form.
	if (totalMinutes === 0) {
		const totalSeconds = Math.max(0, Math.round(ms / 1000));
		return `${totalSeconds}s`;
	}
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (hours > 0) return `${hours}h ${minutes}m`;
	return `${minutes}m`;
}

export interface ObservedRoutingTableProps {
	observations: Record<string, RoutingObservation> | undefined | null;
	now: number;
	/** Shorter inside a disclosure whose summary already names the table. */
	title?: string;
}

/**
 * The single place the proxy's last-observed routing order is rendered: one
 * row per recorded model family -- ALL of them, via listObservedFamilies,
 * including a family that also has its own weekly_scoped pool row (e.g.
 * "fable"). Renders nothing at all when there are no observations yet (no
 * heading, no empty box).
 */
export function ObservedRoutingTable({
	observations,
	now,
	title = "Observed routing order — the last decision the proxy actually made",
}: ObservedRoutingTableProps) {
	const families = listObservedFamilies(observations);
	if (families.length === 0) return null;

	return (
		<div className="mt-4 border-t pt-3">
			<h4 className="mb-2 text-xs text-muted-foreground">{title}</h4>
			<div className="space-y-2.5">
				{families.map(({ family, observation }) => (
					<div
						key={family}
						className="flex flex-wrap items-start gap-x-3 gap-y-1.5 lg:flex-nowrap lg:items-center"
					>
						<span className="inline-flex shrink-0 items-center justify-center rounded bg-muted px-2 py-0.5 text-xs font-semibold lg:w-20">
							{formatFamilyLabel(family)}
						</span>
						<div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
							{observation.order.map((account, index) => {
								const isFirst = index === 0;
								return (
									<Fragment key={account.id}>
										{index > 0 && (
											<ChevronRight
												className="h-3 w-3 shrink-0 text-muted-foreground"
												aria-hidden="true"
											/>
										)}
										<span
											className={cn(
												"inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
												isFirst
													? "border-primary text-orange-700 dark:text-primary"
													: "border-border text-muted-foreground",
											)}
											title={`Position ${index + 1} of ${family} routing order`}
										>
											<span
												className={cn(
													"flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold",
													isFirst
														? "bg-primary text-primary-foreground"
														: "bg-muted text-muted-foreground",
												)}
											>
												{index + 1}
											</span>
											{account.name}
										</span>
									</Fragment>
								);
							})}
						</div>
						<span className="shrink-0 text-xs text-muted-foreground lg:w-[110px] lg:text-right">
							observed {formatShortDuration(now - observation.observedAtMs)} ago
						</span>
					</div>
				))}
			</div>
		</div>
	);
}
