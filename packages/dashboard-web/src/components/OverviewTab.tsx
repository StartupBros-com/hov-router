import { registerUIRefresh } from "@hov-router/core";
import {
	formatCost,
	formatNumber,
	formatPercentage,
	formatTokensPerSecond,
} from "@hov-router/ui-common";
import { format } from "date-fns";
import { Activity, CheckCircle, Clock, DollarSign, Zap } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { Account } from "../api";
import {
	useAccounts,
	useAnalytics,
	useRedeemReset,
	useRoutingObservations,
} from "../hooks/queries";
import { useApiError } from "../hooks/useApiError";
import { buildPoolGroups } from "../lib/pool-forecast";
import { UseResetDialog } from "./accounts/UseResetDialog";
import { ChartsSection } from "./overview/ChartsSection";
import { MetricCard } from "./overview/MetricCard";
import { PoolCapacitySection } from "./overview/PoolCapacitySection";
import { RateLimitInfo } from "./overview/RateLimitInfo";
import {
	StorageIntegrityBanner,
	StorageIntegrityCard,
} from "./overview/StorageIntegrityCard";
import { SystemStatus } from "./overview/SystemStatus";
import { TimeRangeSelector } from "./overview/TimeRangeSelector";
import { RoutePageHeader } from "./page-shell";
import { ErrorState, LoadingState } from "./ui/state";

export const OverviewTab = React.memo(() => {
	// Fetch all data using React Query hooks
	const { formatError } = useApiError();
	const [timeRange, setTimeRange] = useState("24h");
	const {
		data: analytics,
		isLoading: analyticsLoading,
		isError,
		error,
		refetch,
	} = useAnalytics(
		timeRange,
		{ accounts: [], models: [], status: "all" },
		"normal",
	);
	const {
		data: accounts,
		isError: accountsFailed,
		error: accountsError,
		refetch: refetchAccounts,
	} = useAccounts();
	const { data: routingObservationsResponse } = useRoutingObservations();

	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		return registerUIRefresh({
			id: "pool-metric-card-update",
			callback: () => setNow(Date.now()),
			seconds: 30,
			description: "Combined-quota tile refresh",
		});
	}, []);

	// isPrimary comes from strategy.peek() on the server and remains the
	// single source for "next request". Never infer a pick from chart order.
	const { groups, hidden } = useMemo(
		() => buildPoolGroups(accounts ?? [], now),
		[accounts, now],
	);
	const redeemReset = useRedeemReset();
	const [useResetAccount, setUseResetAccount] = useState<Account | null>(null);

	// Memoize percentage change calculation (must be at top level)
	const pctChange = useCallback(
		(current: number, previous: number): number | null => {
			if (previous === 0) return null; // avoid division by zero
			return ((current - previous) / previous) * 100;
		},
		[],
	);

	// Memoize trend period description
	const getTrendPeriod = useCallback((range: string): string => {
		switch (range) {
			case "1h":
				return "previous minute";
			case "6h":
				return "previous 5 minutes";
			case "24h":
				return "previous hour";
			case "7d":
				return "previous hour";
			case "30d":
				return "previous day";
			default:
				return "previous period";
		}
	}, []);

	const loading = analyticsLoading;

	// Transform time series data
	const timeSeriesData = useMemo(() => {
		if (!analytics) return [];
		return analytics.timeSeries.map((point) => ({
			time: format(new Date(point.ts), "HH:mm"),
			requests: point.requests,
			successRate: point.successRate,
			responseTime: Math.round(point.avgResponseTime),
			cost: point.costUsd.toFixed(2),
			planCost: point.planCostUsd ?? 0,
			apiCost: point.apiCostUsd ?? 0,
			tokensPerSecond: point.avgTokensPerSecond || 0,
		}));
	}, [analytics]);

	// Memoize percentage changes calculation
	const trends = useMemo(() => {
		if (timeSeriesData.length < 2) {
			return {
				deltaRequests: null,
				deltaSuccessRate: null,
				deltaResponseTime: null,
				deltaCost: null,
				deltaOutputSpeed: null,
				trendRequests: "flat" as "up" | "down" | "flat",
				trendSuccessRate: "flat" as "up" | "down" | "flat",
				trendResponseTime: "flat" as "up" | "down" | "flat",
				trendCost: "flat" as "up" | "down" | "flat",
				trendOutputSpeed: "flat" as "up" | "down" | "flat",
			};
		}

		const lastBucket = timeSeriesData[timeSeriesData.length - 1];
		const prevBucket = timeSeriesData[timeSeriesData.length - 2];

		// Calculate deltas
		const deltaRequests = pctChange(lastBucket.requests, prevBucket.requests);
		const deltaSuccessRate = pctChange(
			lastBucket.successRate,
			prevBucket.successRate,
		);
		const deltaResponseTime = pctChange(
			lastBucket.responseTime,
			prevBucket.responseTime,
		);
		const deltaCost = pctChange(
			parseFloat(lastBucket.cost),
			parseFloat(prevBucket.cost),
		);
		const deltaOutputSpeed = pctChange(
			lastBucket.tokensPerSecond,
			prevBucket.tokensPerSecond,
		);

		// Helper to determine trend
		const getTrend = (
			delta: number | null,
			invert = false,
		): "up" | "down" | "flat" => {
			if (delta === null) return "flat";
			const isPositive = delta >= 0;
			return invert ? (isPositive ? "down" : "up") : isPositive ? "up" : "down";
		};

		return {
			deltaRequests,
			deltaSuccessRate,
			deltaResponseTime,
			deltaCost,
			deltaOutputSpeed,
			trendRequests: getTrend(deltaRequests),
			trendSuccessRate: getTrend(deltaSuccessRate),
			trendResponseTime: getTrend(deltaResponseTime, true), // invert: higher response time is bad
			trendCost: getTrend(deltaCost, true), // invert: higher cost is bad
			trendOutputSpeed: getTrend(deltaOutputSpeed),
		};
	}, [timeSeriesData, pctChange]);

	const trendPeriod = getTrendPeriod(timeRange);

	// Use analytics data for model distribution
	const modelData =
		analytics?.modelDistribution?.map((model) => ({
			name: model.model || "Unknown",
			value: model.count,
		})) || [];

	// Use analytics data for account health
	const accountHealthData = analytics?.accountPerformance || [];

	const accountModelUsageData = analytics?.accountModelUsage || [];
	const apiKeyPerformanceData = analytics?.apiKeyPerformance || [];

	return (
		<div className="space-y-4">
			<RoutePageHeader
				page="overview"
				actions={
					<TimeRangeSelector value={timeRange} onChange={setTimeRange} />
				}
			/>
			<div className="space-y-6">
				{/* Sticky corruption banner — only renders when /api/storage reports corrupt */}
				<StorageIntegrityBanner />

				{analytics === undefined ? (
					isError ? (
						<ErrorState
							title="Analytics could not load"
							message={formatError(error)}
							onRetry={() => void refetch()}
						/>
					) : (
						<LoadingState label="Loading analytics" />
					)
				) : (
					<>
						{/* Metrics Grid */}
						<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6 gap-4">
							<MetricCard
								title="Total Requests"
								value={formatNumber(analytics?.totals.requests || 0)}
								change={
									trends.deltaRequests !== null
										? trends.deltaRequests
										: undefined
								}
								trend={trends.trendRequests}
								trendPeriod={trendPeriod}
								icon={Activity}
							/>
							<MetricCard
								title="Success Rate"
								value={formatPercentage(analytics?.totals.successRate || 0, 0)}
								change={
									trends.deltaSuccessRate !== null
										? trends.deltaSuccessRate
										: undefined
								}
								trend={trends.trendSuccessRate}
								trendPeriod={trendPeriod}
								icon={CheckCircle}
							/>
							<MetricCard
								title="Avg Response Time"
								value={`${Math.round(analytics?.totals.avgResponseTime || 0)}ms`}
								change={
									trends.deltaResponseTime !== null
										? trends.deltaResponseTime
										: undefined
								}
								trend={trends.trendResponseTime}
								trendPeriod={trendPeriod}
								icon={Clock}
							/>
							<MetricCard
								title="Plan Value"
								value={
									analytics?.totals.planCostUsd
										? formatCost(analytics.totals.planCostUsd)
										: "$0.0000"
								}
								trendPeriod={trendPeriod}
								icon={DollarSign}
								subRows={[
									{
										label: "Avg / day",
										value: formatCost(
											analytics?.totals.avgDailyPlanCostUsd ?? 0,
										),
										tooltip: "Average daily plan value over the last 7 days",
									},
									{
										label: "Avg / week",
										value: formatCost(
											analytics?.totals.avgWeeklyPlanCostUsd ?? 0,
										),
										tooltip:
											"Average weekly plan value, derived from the last 30 days",
									},
								]}
							/>
							<MetricCard
								title="API Cost"
								value={
									analytics?.totals.apiCostUsd
										? formatCost(analytics.totals.apiCostUsd)
										: "$0.0000"
								}
								change={
									trends.deltaCost !== null ? trends.deltaCost : undefined
								}
								trend={trends.trendCost}
								trendPeriod={trendPeriod}
								icon={DollarSign}
								subRows={[
									...(analytics?.totals.avgDailyApiCostUsd != null
										? [
												{
													label: "Avg / day",
													value: formatCost(
														analytics.totals.avgDailyApiCostUsd,
													),
													tooltip:
														"Average daily API cost over the last 7 days",
												},
											]
										: []),
									...(analytics?.totals.avgWeeklyApiCostUsd != null
										? [
												{
													label: "Avg / week",
													value: formatCost(
														analytics.totals.avgWeeklyApiCostUsd,
													),
													tooltip:
														"Average weekly API cost, derived from the last 30 days",
												},
											]
										: []),
								]}
							/>
							<MetricCard
								title="Output Speed"
								value={formatTokensPerSecond(
									analytics?.totals.avgTokensPerSecond,
								)}
								change={
									trends.deltaOutputSpeed !== null
										? trends.deltaOutputSpeed
										: undefined
								}
								trend={trends.trendOutputSpeed}
								trendPeriod={trendPeriod}
								icon={Zap}
							/>
						</div>
					</>
				)}
				<PoolCapacitySection
					groups={groups}
					hidden={hidden}
					loading={accounts === undefined && !accountsFailed}
					onUseReset={setUseResetAccount}
					now={now}
					observations={routingObservationsResponse?.observations}
					loadError={
						accounts === undefined && accountsFailed
							? {
									message: formatError(accountsError),
									onRetry: () => void refetchAccounts(),
								}
							: null
					}
				/>

				{analytics !== undefined && (
					<ChartsSection
						timeSeriesData={timeSeriesData}
						modelData={modelData}
						accountHealthData={accountHealthData}
						accountModelUsageData={accountModelUsageData}
						apiKeyPerformanceData={apiKeyPerformanceData}
						loading={loading}
					/>
				)}

				<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
					<SystemStatus />
					<StorageIntegrityCard />
				</div>

				{accounts && <RateLimitInfo accounts={accounts} now={now} />}
			</div>
			{useResetAccount && (
				<UseResetDialog
					key={useResetAccount.id}
					account={useResetAccount}
					redeem={(accountId, requestId) =>
						redeemReset.mutateAsync({ accountId, requestId })
					}
					onClose={() => setUseResetAccount(null)}
				/>
			)}
		</div>
	);
});
