import { Info } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { cn } from "../../lib/utils";
import { Card, CardContent } from "./card";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { TrendIndicator, type TrendQuality } from "./trend-indicator";

export interface StatTileRow {
	label: string;
	value: ReactNode;
	/** Shown in a popover when the value is pressed. */
	tooltip?: string;
	/** A tone the caller decides, such as `text-destructive`. */
	valueClassName?: string;
}

export interface StatTileTrend {
	change: number;
	quality: TrendQuality;
	/** What the change is measured against, such as "previous hour". */
	comparedTo?: string;
}

export interface StatTileProps {
	label: string;
	value: ReactNode;
	hint?: ReactNode;
	icon?: ComponentType<{ className?: string }>;
	trend?: StatTileTrend;
	rows?: StatTileRow[];
	/** A tone the caller decides for the value. The tile adds none itself. */
	valueClassName?: string;
}

const POPOVER_BUTTON =
	"cursor-help rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function Trend({ trend }: { trend: StatTileTrend }) {
	const indicator = (
		<TrendIndicator change={trend.change} quality={trend.quality} />
	);
	if (!trend.comparedTo) return indicator;
	return (
		<Popover>
			<PopoverTrigger asChild>
				<button
					type="button"
					className={cn("flex items-center gap-1", POPOVER_BUTTON)}
				>
					{indicator}
					<Info className="h-3 w-3 text-muted-foreground" />
					<span className="sr-only">Compared to {trend.comparedTo}</span>
				</button>
			</PopoverTrigger>
			<PopoverContent className="w-auto p-2 text-xs">
				<p>Compared to {trend.comparedTo}</p>
			</PopoverContent>
		</Popover>
	);
}

function RowValue({ row }: { row: StatTileRow }) {
	const className = cn(
		"font-medium tabular-nums text-right",
		row.valueClassName,
	);
	if (!row.tooltip) return <span className={className}>{row.value}</span>;
	return (
		<Popover>
			<PopoverTrigger asChild>
				<button
					type="button"
					className={cn(
						"inline-flex min-h-6 items-center",
						POPOVER_BUTTON,
						className,
					)}
				>
					{row.value}
				</button>
			</PopoverTrigger>
			<PopoverContent className="w-auto p-2 text-xs">
				<p>{row.tooltip}</p>
			</PopoverContent>
		</Popover>
	);
}

/** One headline number in a card: a label, the value, and what explains it. */
export function StatTile({
	label,
	value,
	hint,
	icon: Icon,
	trend,
	rows,
	valueClassName,
}: StatTileProps) {
	return (
		<Card>
			<CardContent className="p-6">
				{(Icon || trend) && (
					<div className="flex items-center justify-between mb-4">
						{Icon ? (
							<Icon className="h-8 w-8 text-muted-foreground/20" />
						) : (
							<span />
						)}
						{trend && <Trend trend={trend} />}
					</div>
				)}
				<div className="space-y-1">
					<p className="text-sm text-muted-foreground">{label}</p>
					<p className={cn("text-2xl font-bold tabular-nums", valueClassName)}>
						{value}
					</p>
					{hint && <p className="text-xs text-muted-foreground">{hint}</p>}
				</div>
				{rows && rows.length > 0 && (
					<div className="mt-3 pt-3 border-t border-border/50 space-y-1">
						{rows.map((row) => (
							<div
								key={row.label}
								className="flex items-baseline justify-between text-xs gap-2"
							>
								<span className="text-muted-foreground shrink-0">
									{row.label}
								</span>
								<RowValue row={row} />
							</div>
						))}
					</div>
				)}
			</CardContent>
		</Card>
	);
}
