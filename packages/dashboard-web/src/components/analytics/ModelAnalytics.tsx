import { Activity, BarChart3, TrendingUp, Zap } from "lucide-react";
import { useState } from "react";
import type { TimeRange } from "../../constants";
import { ModelPerformanceComparison, ModelTokenSpeedChart } from "../charts";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";
import { StatTile, type StatTileRow } from "../ui/stat-tile";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";

interface ModelAnalyticsProps {
	modelPerformance: Array<{
		model: string;
		avgResponseTime: number;
		p95ResponseTime: number;
		errorRate: number;
		avgTokensPerSecond: number | null;
		minTokensPerSecond: number | null;
		maxTokensPerSecond: number | null;
	}>;
	costByModel: Array<{
		model: string;
		costUsd: number;
		requests: number;
		totalTokens?: number;
	}>;
	loading?: boolean;
	timeRange: TimeRange;
}

export function ModelAnalytics({
	modelPerformance,
	costByModel,
	loading = false,
}: ModelAnalyticsProps) {
	const [comparisonView, setComparisonView] = useState<
		"speed-cost" | "performance" | "efficiency"
	>("speed-cost");

	// Prepare data for the comparison chart
	const comparisonData = modelPerformance.map((perf) => {
		const costData = costByModel.find((c) => c.model === perf.model);
		const totalCost = costData?.costUsd || 0;
		const totalRequests = costData?.requests || 1;
		const totalTokens = costData?.totalTokens || 0;

		// Calculate cost per 1k tokens
		let costPer1kTokens: number;
		if (totalTokens > 0) {
			// Use actual token count for accurate calculation
			costPer1kTokens = (totalCost / totalTokens) * 1000;
		} else {
			// Fallback: estimate based on average cost per request
			const avgCostPerRequest = totalCost / totalRequests;
			const _estimatedTokensPerRequest = 1000; // Rough estimate
			costPer1kTokens = avgCostPerRequest;
		}

		return {
			model: perf.model,
			avgTokensPerSecond: perf.avgTokensPerSecond,
			costPer1kTokens,
			avgResponseTime: perf.avgResponseTime,
			errorRate: perf.errorRate,
			totalRequests,
		};
	});

	return (
		<div className="space-y-6">
			{/* Header with title and controls */}
			<div className="flex items-center justify-between">
				<div>
					<h2 className="text-lg font-semibold">Model Performance Analytics</h2>
					<p className="text-sm text-muted-foreground">
						Speed, cost, and reliability for each model
					</p>
				</div>
			</div>

			{/* Tabbed interface for different views */}
			<Tabs defaultValue="comparison" className="space-y-4">
				<TabsList className="grid w-full grid-cols-2">
					<TabsTrigger value="comparison" className="flex items-center gap-2">
						<TrendingUp className="h-4 w-4" />
						Multi-Metric Comparison
					</TabsTrigger>
					<TabsTrigger value="detailed" className="flex items-center gap-2">
						<BarChart3 className="h-4 w-4" />
						Detailed Analysis
					</TabsTrigger>
				</TabsList>

				{/* Multi-Metric Comparison Tab */}
				<TabsContent value="comparison" className="space-y-4">
					<Card className="bg-gradient-to-br from-background to-muted/10 border-muted">
						<CardHeader>
							<div className="flex flex-wrap items-center justify-between gap-4">
								<div className="space-y-1">
									<CardTitle className="text-lg sm:text-2xl font-bold flex items-center gap-2">
										<Zap className="h-6 w-6 text-chart-purple" />
										Model Performance Comparison
									</CardTitle>
									<CardDescription>
										{comparisonView === "speed-cost"
											? "Token generation speed vs. cost efficiency"
											: comparisonView === "performance"
												? "Response time and error rate analysis"
												: "Overall efficiency score (speed/cost ratio)"}
									</CardDescription>
								</div>
								<Select
									value={comparisonView}
									onValueChange={(v) =>
										setComparisonView(
											v as "speed-cost" | "performance" | "efficiency",
										)
									}
								>
									<SelectTrigger className="w-48" aria-label="Comparison view">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="speed-cost">
											<div className="flex items-center gap-2">
												<Zap className="h-4 w-4" />
												Speed vs Cost
											</div>
										</SelectItem>
										<SelectItem value="performance">
											<div className="flex items-center gap-2">
												<Activity className="h-4 w-4" />
												Performance Metrics
											</div>
										</SelectItem>
										<SelectItem value="efficiency">
											<div className="flex items-center gap-2">
												<TrendingUp className="h-4 w-4" />
												Efficiency Score
											</div>
										</SelectItem>
									</SelectContent>
								</Select>
							</div>
						</CardHeader>
						<CardContent>
							<ModelPerformanceComparison
								data={comparisonData}
								loading={loading}
								height={400}
								viewMode={comparisonView}
							/>
						</CardContent>
					</Card>
				</TabsContent>

				{/* Detailed Analysis Tab */}
				<TabsContent value="detailed" className="space-y-4">
					<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
						{/* Token Speed Chart */}
						<Card>
							<CardHeader>
								<CardTitle className="flex items-center gap-2">
									<Zap className="h-5 w-5" />
									Token Generation Speed
								</CardTitle>
								<CardDescription>
									Average, min, and max tokens per second by model
								</CardDescription>
							</CardHeader>
							<CardContent>
								<ModelTokenSpeedChart
									data={modelPerformance}
									loading={loading}
									height={350}
								/>
							</CardContent>
						</Card>

						<ModelDetailTiles
							modelPerformance={modelPerformance}
							comparisonData={comparisonData}
						/>
					</div>
				</TabsContent>
			</Tabs>
		</div>
	);
}

interface ModelComparisonRow {
	model: string;
	avgTokensPerSecond: number | null;
	costPer1kTokens: number;
	avgResponseTime: number;
	errorRate: number;
	totalRequests: number;
}

function ModelTile({
	label,
	model,
	rows,
}: {
	label: string;
	model: string | undefined;
	rows: StatTileRow[] | undefined;
}) {
	if (model === undefined)
		return (
			<StatTile
				label={label}
				value="No data"
				valueClassName="text-muted-foreground"
			/>
		);
	return <StatTile label={label} value={model} rows={rows} />;
}

/** The Detailed Analysis tab's fastest, most reliable and cheapest models. */
export function ModelDetailTiles({
	modelPerformance,
	comparisonData,
}: {
	modelPerformance: ModelAnalyticsProps["modelPerformance"];
	comparisonData: ModelComparisonRow[];
}) {
	const fastest = modelPerformance
		.filter((m) => m.avgTokensPerSecond !== null)
		.sort(
			(a, b) => (b.avgTokensPerSecond || 0) - (a.avgTokensPerSecond || 0),
		)[0];
	const reliable = modelPerformance.sort(
		(a, b) => a.errorRate - b.errorRate,
	)[0];
	const costEffective = comparisonData
		.filter((m) => m.avgTokensPerSecond !== null && m.costPer1kTokens > 0)
		.sort((a, b) => {
			const efficiencyA = (a.avgTokensPerSecond || 0) / a.costPer1kTokens;
			const efficiencyB = (b.avgTokensPerSecond || 0) / b.costPer1kTokens;
			return efficiencyB - efficiencyA;
		})[0];

	return (
		<div className="space-y-4">
			<ModelTile
				label="Fastest Model"
				model={fastest?.model}
				rows={
					fastest && [
						{
							label: "Speed",
							value: `${fastest.avgTokensPerSecond?.toFixed(1)} tok/s`,
						},
						{
							label: "Response",
							value: `${fastest.avgResponseTime.toFixed(0)}ms`,
						},
					]
				}
			/>
			<ModelTile
				label="Most Reliable Model"
				model={reliable?.model}
				rows={
					reliable && [
						{ label: "Error Rate", value: `${reliable.errorRate.toFixed(2)}%` },
						{
							label: "p95 Response",
							value: `${reliable.p95ResponseTime.toFixed(0)}ms`,
						},
					]
				}
			/>
			<ModelTile
				label="Most Cost-Effective"
				model={costEffective?.model}
				rows={
					costEffective && [
						{
							label: "Efficiency",
							value: `${(
								(costEffective.avgTokensPerSecond || 0) /
									costEffective.costPer1kTokens
							).toFixed(2)} tok/s/$`,
						},
						{
							label: "Cost/1K",
							value: `$${costEffective.costPer1kTokens.toFixed(3)}`,
						},
					]
				}
			/>
		</div>
	);
}
