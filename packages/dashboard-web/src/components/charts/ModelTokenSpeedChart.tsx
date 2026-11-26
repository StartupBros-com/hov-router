import { formatTokensPerSecond } from "@hov-router/ui-common";
import {
	Bar,
	BarChart,
	CartesianGrid,
	Cell,
	ErrorBar,
	ResponsiveContainer,
	XAxis,
	YAxis,
} from "recharts";
import { CHART_PROPS } from "../../constants";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { formatCompactNumber } from "../../lib/chart-utils";
import { Skeleton } from "../ui/skeleton";
import { PHONE_MODEL_AXIS_HEIGHT, phoneModelLabel } from "./axis-labels";
import { ChartTooltip } from "./ChartTooltip";
import { getTooltipStyles } from "./chart-utils";
import { getModelColor } from "./model-colors";

interface ModelTokenSpeedData {
	model: string;
	avgTokensPerSecond: number | null;
	minTokensPerSecond: number | null;
	maxTokensPerSecond: number | null;
}

interface ModelTokenSpeedChartProps {
	data: ModelTokenSpeedData[];
	loading?: boolean;
	height?: number;
}

function tokenSpeedTooltipFormatter(value: number, name: string) {
	if (name === "avgSpeed") {
		return [formatTokensPerSecond(value), "Avg Speed"];
	}
	return [value, name];
}

function tokenSpeedLabelFormatter(label: string) {
	return `Model: ${label}`;
}

const DESKTOP_MODEL_AXIS_HEIGHT = 80;

export function ModelTokenSpeedChart({
	data,
	loading = false,
	height = 300,
}: ModelTokenSpeedChartProps) {
	// On a phone the 60 px left margin and the rotated axis title left the
	// plot 88 px of a 238 px chart. Below sm both go, and the model names
	// stand upright; the chart grows by the deeper axis so the plot keeps its
	// height. The tooltip still names the model and its units.
	const isWide = useMediaQuery("(min-width: 640px)");
	const modelAxisHeight = isWide
		? DESKTOP_MODEL_AXIS_HEIGHT
		: PHONE_MODEL_AXIS_HEIGHT;
	const chartHeight = height + modelAxisHeight - DESKTOP_MODEL_AXIS_HEIGHT;

	if (loading)
		return (
			<Skeleton
				style={{ height }}
				role="status"
				aria-label="Loading model token speeds"
			/>
		);

	// Filter out models without token speed data and prepare chart data
	const chartData = data
		.filter((d) => d.avgTokensPerSecond !== null && d.avgTokensPerSecond > 0)
		.map((d) => ({
			model: d.model,
			avgSpeed: d.avgTokensPerSecond || 0,
			minSpeed: d.minTokensPerSecond || 0,
			maxSpeed: d.maxTokensPerSecond || 0,
			// Calculate error bars (distance from avg to min/max)
			errorLower: (d.avgTokensPerSecond || 0) - (d.minTokensPerSecond || 0),
			errorUpper: (d.maxTokensPerSecond || 0) - (d.avgTokensPerSecond || 0),
		}))
		.sort((a, b) => b.avgSpeed - a.avgSpeed); // Sort by average speed

	if (chartData.length === 0) {
		return (
			<div
				className="flex items-center justify-center text-muted-foreground"
				style={{ height }}
			>
				No token speed data available
			</div>
		);
	}

	return (
		<ResponsiveContainer width="100%" height={chartHeight}>
			<BarChart
				data={chartData}
				margin={
					isWide
						? { top: 20, right: 30, left: 60, bottom: 80 }
						: { top: 20, right: 8, left: 0, bottom: 80 }
				}
			>
				<CartesianGrid
					stroke={CHART_PROPS.gridStroke}
					strokeDasharray={CHART_PROPS.strokeDasharray}
					className={CHART_PROPS.gridClassName}
				/>
				<XAxis
					stroke={CHART_PROPS.axisStroke}
					dataKey="model"
					fontSize={12}
					angle={isWide ? -45 : -90}
					textAnchor="end"
					height={modelAxisHeight}
					tickFormatter={isWide ? undefined : phoneModelLabel}
					interval={0}
				/>
				<YAxis
					stroke={CHART_PROPS.axisStroke}
					fontSize={12}
					tickFormatter={formatCompactNumber}
					label={
						isWide
							? {
									fill: CHART_PROPS.axisStroke,
									value: "Tokens/Second",
									angle: -90,
									position: "insideLeft",
									style: {
										textAnchor: "middle",
										fontSize: 12,
									},
								}
							: undefined
					}
				/>
				<ChartTooltip
					itemStyle={{ color: "var(--popover-foreground)" }}
					cursor={{ fill: CHART_PROPS.cursorFill }}
					contentStyle={getTooltipStyles("default")}
					// biome-ignore lint/suspicious/noExplicitAny: recharts v3.8 widened Formatter to include undefined
					formatter={tokenSpeedTooltipFormatter as any}
					// biome-ignore lint/suspicious/noExplicitAny: recharts v3.8 widened labelFormatter label to ReactNode
					labelFormatter={tokenSpeedLabelFormatter as any}
				/>
				<Bar dataKey="avgSpeed" name="Average Speed">
					{chartData.map((entry) => (
						<Cell
							key={`cell-${entry.model}`}
							fill={getModelColor(entry.model)}
						/>
					))}
					<ErrorBar
						stroke={CHART_PROPS.axisStroke}
						dataKey="errorLower"
						width={4}
						strokeOpacity={0.5}
						direction="y"
					/>
				</Bar>
			</BarChart>
		</ResponsiveContainer>
	);
}
