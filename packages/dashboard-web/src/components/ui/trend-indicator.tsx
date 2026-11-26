import { formatPercentage } from "@hov-router/ui-common";
import { TrendingDown, TrendingUp } from "lucide-react";
import { cn } from "../../lib/utils";

export type TrendQuality = "better" | "worse";

const QUALITY_CLASS: Record<TrendQuality, string> = {
	better: "text-success",
	worse: "text-(--danger)",
};

const BASE = "flex items-center gap-1 text-sm font-medium tabular-nums";

/**
 * A percentage change. The arrow follows the sign of the change and the
 * colour follows whether that change is good, so a rising response time is a
 * red up arrow. A change that rounds to 0% shows no arrow and no colour.
 */
export function TrendIndicator({
	change,
	quality,
	className,
}: {
	change: number;
	quality: TrendQuality;
	className?: string;
}) {
	const text = formatPercentage(Math.abs(change), 0);
	if (text === "0%") {
		return (
			<span className={cn(BASE, "text-muted-foreground", className)}>
				<span className="sr-only">No change, </span>
				<span>{text}</span>
			</span>
		);
	}
	const rising = change > 0;
	const Arrow = rising ? TrendingUp : TrendingDown;
	return (
		<span className={cn(BASE, QUALITY_CLASS[quality], className)}>
			<Arrow className="h-4 w-4" />
			<span className="sr-only">{rising ? "Up " : "Down "}</span>
			<span>{text}</span>
			<span className="sr-only">{`, ${quality}`}</span>
		</span>
	);
}
