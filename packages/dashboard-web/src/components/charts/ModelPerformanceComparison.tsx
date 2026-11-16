import { formatCost, formatTokensPerSecond } from "@better-ccflare/ui-common";
import {
	Area,
	AreaChart,
	Bar,
	CartesianGrid,
	ComposedChart,
	Legend,
	Line,
	ResponsiveContainer,
	Scatter,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import {
	CHART_HEIGHTS,
	CHART_PROPS,
	CHART_TOOLTIP_STYLE,
	COLORS,
} from "../../constants";
import { ChartContainer } from "./ChartContainer";
import { getTooltipStyles } from "./chart-utils";
import { getModelColor } from "./model-colors";

interface ModelComparisonData {
	model: string;
	avgTokensPerSecond: number | null;
	costPer1kTokens: number;
	avgResponseTime: number;
	errorRate: number;
	totalRequests: number;
}

interface ModelPerformanceComparisonProps {
	data: ModelComparisonData[];
	loading?: boolean;
	height?: number;
	viewMode?: "speed-cost" | "performance" | "efficiency";
}

function speedCostTooltipFormatter(value: number, name: string) {
	if (name === "Speed") return [formatTokensPerSecond(value), name];
	if (name === "Cost/1K") return [formatCost(value), name];
	return [value, name];
}

function performanceTooltipFormatter(value: number, name: string) {
	if (name === "Response Time") return [`${value}ms`, name];
	if (name === "Error Rate") return [`${value}%`, name];
	return [value, name];
}

export function ModelPerformanceComparison({
	data,
	loading = false,
	height = CHART_HEIGHTS.large,
	viewMode = "speed-cost",
}: ModelPerformanceComparisonProps) {
	// Filter and prepare data
	const chartData = data
		.filter((d) => d.avgTokensPerSecond !== null && d.avgTokensPerSecond > 0)
		.sort((a, b) => (b.avgTokensPerSecond || 0) - (a.avgTokensPerSecond || 0));

	if (viewMode === "speed-cost") {
		return (
			<ChartContainer
				loading={loading}
				height={height}
				isEmpty={chartData.length === 0}
				emptyState={
					<div className="text-muted-foreground">
						No model performance data available
					</div>
				}
			>
				<ResponsiveContainer width="100%" height={height}>
					<ComposedChart
						data={chartData}
						margin={{ top: 20, right: 30, left: 20, bottom: 80 }}
					>
						<defs>
							<linearGradient id="speedGradient" x1="0" y1="0" x2="0" y2="1">
								<stop offset="0%" stopColor={COLORS.purple} stopOpacity={0.9} />
								<stop
									offset="100%"
									stopColor={COLORS.purple}
									stopOpacity={0.3}
								/>
							</linearGradient>
							<linearGradient id="costGradient" x1="0" y1="0" x2="0" y2="1">
								<stop
									offset="0%"
									stopColor={COLORS.warning}
									stopOpacity={0.9}
								/>
								<stop
									offset="100%"
									stopColor={COLORS.warning}
									stopOpacity={0.3}
								/>
							</linearGradient>
							<filter id="glow">
								<feGaussianBlur stdDeviation="3" result="coloredBlur" />
								<feMerge>
									<feMergeNode in="coloredBlur" />
									<feMergeNode in="SourceGraphic" />
								</feMerge>
							</filter>
						</defs>
						<CartesianGrid
							strokeDasharray={CHART_PROPS.strokeDasharray}
							stroke={CHART_PROPS.gridStroke}
						/>
						<XAxis
							dataKey="model"
							angle={-45}
							textAnchor="end"
							height={80}
							interval={0}
							fontSize={12}
							stroke={CHART_PROPS.axisStroke}
						/>
						<YAxis
							width="auto"
							yAxisId="speed"
							orientation="left"
							stroke={COLORS.purple}
							fontSize={12}
							label={{
								fill: COLORS.purple,
								value: "Tokens/Second",
								angle: -90,
								position: "insideLeft",
								style: { textAnchor: "middle", fill: COLORS.purple },
							}}
						/>
						<YAxis
							width="auto"
							yAxisId="cost"
							orientation="right"
							stroke={COLORS.warning}
							fontSize={12}
							label={{
								fill: COLORS.warning,
								value: "Cost per 1K Tokens ($)",
								angle: 90,
								position: "insideRight",
								style: { textAnchor: "middle", fill: COLORS.warning },
							}}
						/>
						<Tooltip
							cursor={{ stroke: CHART_PROPS.cursorStroke }}
							contentStyle={{
								...CHART_TOOLTIP_STYLE.default,
								borderRadius: "8px",
								backdropFilter: "blur(8px)",
							}}
							// biome-ignore lint/suspicious/noExplicitAny: recharts v3.8 widened Formatter to include undefined
							formatter={speedCostTooltipFormatter as any}
						/>
						<Legend
							verticalAlign="top"
							height={36}
							iconType="rect"
							wrapperStyle={{ paddingBottom: "10px" }}
						/>
						<Bar
							yAxisId="speed"
							dataKey="avgTokensPerSecond"
							name="Speed"
							fill="url(#speedGradient)"
							filter="url(#glow)"
						/>
						<Line
							activeDot={{ stroke: CHART_PROPS.surfaceStroke }}
							yAxisId="cost"
							type="monotone"
							dataKey="costPer1kTokens"
							name="Cost/1K"
							stroke={COLORS.warning}
							strokeWidth={3}
							dot={{ fill: COLORS.warning, r: 4 }}
							filter="url(#glow)"
						/>
					</ComposedChart>
				</ResponsiveContainer>
			</ChartContainer>
		);
	}

	if (viewMode === "performance") {
		return (
			<ChartContainer
				loading={loading}
				height={height}
				isEmpty={chartData.length === 0}
				emptyState={
					<div className="text-muted-foreground">
						No model performance data available
					</div>
				}
			>
				<ResponsiveContainer width="100%" height={height}>
					<ComposedChart
						data={chartData}
						margin={{ top: 20, right: 30, left: 20, bottom: 80 }}
					>
						<defs>
							<linearGradient id="responseGradient" x1="0" y1="0" x2="0" y2="1">
								<stop offset="0%" stopColor={COLORS.blue} stopOpacity={0.9} />
								<stop offset="100%" stopColor={COLORS.blue} stopOpacity={0.3} />
							</linearGradient>
						</defs>
						<CartesianGrid
							stroke={CHART_PROPS.gridStroke}
							strokeDasharray={CHART_PROPS.strokeDasharray}
							className={CHART_PROPS.gridClassName}
						/>
						<XAxis
							stroke={CHART_PROPS.axisStroke}
							dataKey="model"
							angle={-45}
							textAnchor="end"
							height={80}
							interval={0}
							fontSize={12}
						/>
						<YAxis
							width="auto"
							stroke={CHART_PROPS.axisStroke}
							yAxisId="time"
							orientation="left"
							fontSize={12}
							label={{
								fill: CHART_PROPS.axisStroke,
								value: "Response Time (ms)",
								angle: -90,
								position: "insideLeft",
								style: { textAnchor: "middle" },
							}}
						/>
						<YAxis
							width="auto"
							stroke={CHART_PROPS.axisStroke}
							yAxisId="error"
							orientation="right"
							fontSize={12}
							label={{
								fill: CHART_PROPS.axisStroke,
								value: "Error Rate (%)",
								angle: 90,
								position: "insideRight",
								style: { textAnchor: "middle" },
							}}
						/>
						<Tooltip
							cursor={{ stroke: CHART_PROPS.cursorStroke }}
							contentStyle={getTooltipStyles("dark")}
							// biome-ignore lint/suspicious/noExplicitAny: recharts v3.8 widened Formatter to include undefined
							formatter={performanceTooltipFormatter as any}
						/>
						<Legend verticalAlign="top" height={36} iconType="rect" />
						<Bar
							yAxisId="time"
							dataKey="avgResponseTime"
							name="Response Time"
							fill="url(#responseGradient)"
						/>
						<Scatter
							yAxisId="error"
							dataKey="errorRate"
							name="Error Rate"
							fill={COLORS.error}
						/>
					</ComposedChart>
				</ResponsiveContainer>
			</ChartContainer>
		);
	}

	// Efficiency view: Speed vs Cost scatter plot
	return (
		<ChartContainer
			loading={loading}
			height={height}
			isEmpty={chartData.length === 0}
			emptyState={
				<div className="text-muted-foreground">
					No model efficiency data available
				</div>
			}
		>
			<ResponsiveContainer width="100%" height={height}>
				<AreaChart
					data={chartData}
					margin={{ top: 20, right: 30, left: 60, bottom: 80 }}
				>
					<defs>
						{chartData.map((model, index) => (
							<linearGradient
								key={model.model}
								id={`gradient-${index}`}
								x1="0"
								y1="0"
								x2="0"
								y2="1"
							>
								<stop
									offset="0%"
									stopColor={getModelColor(model.model)}
									stopOpacity={0.9}
								/>
								<stop
									offset="100%"
									stopColor={getModelColor(model.model)}
									stopOpacity={0.1}
								/>
							</linearGradient>
						))}
					</defs>
					<CartesianGrid
						strokeDasharray={CHART_PROPS.strokeDasharray}
						stroke={CHART_PROPS.gridStroke}
					/>
					<XAxis
						stroke={CHART_PROPS.axisStroke}
						dataKey="model"
						angle={-45}
						textAnchor="end"
						height={80}
						interval={0}
						fontSize={12}
					/>
					<YAxis
						width="auto"
						stroke={CHART_PROPS.axisStroke}
						fontSize={12}
						label={{
							fill: CHART_PROPS.axisStroke,
							value: "Efficiency Score",
							angle: -90,
							position: "insideLeft",
							style: { textAnchor: "middle" },
						}}
					/>
					<Tooltip
						cursor={{ stroke: CHART_PROPS.cursorStroke }}
						contentStyle={{
							...CHART_TOOLTIP_STYLE.default,
							borderRadius: "8px",
							backdropFilter: "blur(8px)",
						}}
						content={({ active, payload }) => {
							if (!active || !payload?.[0]) return null;
							const data = payload[0].payload;
							return (
								<div className="p-3 space-y-1">
									<p className="font-semibold">{data.model}</p>
									<p className="text-sm">
										Speed: {formatTokensPerSecond(data.avgTokensPerSecond)}
									</p>
									<p className="text-sm">
										Cost/1K: {formatCost(data.costPer1kTokens)}
									</p>
									<p className="text-sm">
										Efficiency:{" "}
										{(
											(data.avgTokensPerSecond || 0) / data.costPer1kTokens
										).toFixed(2)}
									</p>
								</div>
							);
						}}
					/>
					<Area
						activeDot={{ stroke: CHART_PROPS.surfaceStroke }}
						type="monotone"
						dataKey={(data: ModelComparisonData) =>
							(data.avgTokensPerSecond || 0) / data.costPer1kTokens
						}
						stroke={COLORS.primary}
						strokeWidth={2}
						fill="url(#gradient-0)"
						name="Efficiency Score"
					/>
				</AreaChart>
			</ResponsiveContainer>
		</ChartContainer>
	);
}
