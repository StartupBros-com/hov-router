import type { ComponentProps, CSSProperties } from "react";
import { Tooltip, useChartWidth, useOffset } from "recharts";

type ChartTooltipProps = ComponentProps<typeof Tooltip>;

const WRAP: CSSProperties = { whiteSpace: "normal", overflowWrap: "anywhere" };

/**
 * The widest a tooltip can be and still end inside the chart. recharts moves a
 * tooltip that does not fit no further left than the plot's left edge, and
 * never limits its right edge, so the room is the chart's width minus that
 * edge. No cap until the chart has been measured.
 */
export function chartTooltipMaxWidth(
	chartWidth: number | undefined,
	plotLeft: number | undefined,
): number | undefined {
	if (!chartWidth) return undefined;
	return chartWidth - (plotLeft ?? 0);
}

/**
 * recharts' Tooltip, kept inside the chart: its width is capped and its text
 * wraps instead of running off the right edge on a narrow screen. Every chart
 * tooltip goes through this helper.
 */
export function ChartTooltip({
	wrapperStyle,
	contentStyle,
	...props
}: ChartTooltipProps) {
	const maxWidth = chartTooltipMaxWidth(useChartWidth(), useOffset()?.left);
	return (
		<Tooltip
			{...props}
			wrapperStyle={{
				...wrapperStyle,
				...WRAP,
				...(maxWidth === undefined ? {} : { maxWidth }),
			}}
			contentStyle={{ ...contentStyle, ...WRAP }}
		/>
	);
}
