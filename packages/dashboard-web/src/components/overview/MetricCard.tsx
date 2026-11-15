import { StatTile, type StatTileRow } from "../ui/stat-tile";

export type MetricCardSubRow = Omit<StatTileRow, "valueClassName">;

export interface MetricCardProps {
	title: string;
	value: string | number;
	change?: number;
	icon: React.ComponentType<{ className?: string }>;
	/** Whether the change is good ("up") or bad ("down"), not its direction. */
	trend?: "up" | "down" | "flat";
	trendPeriod?: string;
	subRows?: MetricCardSubRow[];
}

/** Overview's metric card: a StatTile whose trend Overview has already rated. */
export function MetricCard({
	title,
	value,
	change,
	icon,
	trend,
	trendPeriod,
	subRows,
}: MetricCardProps) {
	const rated = trend !== undefined && trend !== "flat" && change !== undefined;
	return (
		<StatTile
			label={title}
			value={value}
			icon={icon}
			rows={subRows}
			trend={
				rated
					? {
							change,
							quality: trend === "up" ? "better" : "worse",
							comparedTo: trendPeriod,
						}
					: undefined
			}
		/>
	);
}
