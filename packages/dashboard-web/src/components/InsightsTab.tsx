import React, { useState } from "react";
import type { TimeRange } from "../constants";
import {
	useAnomalyInsights,
	useCacheInsights,
	useContextInsights,
} from "../hooks/queries";
import { useApiError } from "../hooks/useApiError";
import { AlertsView } from "./insights/AlertsView";
import { AnomaliesView } from "./insights/AnomaliesView";
import { CacheEfficiencyView } from "./insights/CacheEfficiencyView";
import { ContextCompositionView } from "./insights/ContextCompositionView";
import { TimeRangeSelector } from "./overview/TimeRangeSelector";
import { RoutePageHeader } from "./page-shell";
import { ErrorState, LoadingState } from "./ui/state";

export const InsightsTab = React.memo(() => {
	const [timeRange, setTimeRange] = useState<TimeRange>("24h");

	const { formatError } = useApiError();
	const cache = useCacheInsights(timeRange);
	const context = useContextInsights(timeRange);
	const anomaly = useAnomalyInsights(timeRange);

	return (
		<div className="space-y-4">
			<RoutePageHeader page="insights" />
			<div className="space-y-6">
				{/* Controls */}
				<div className="flex flex-col sm:flex-row gap-4 justify-between">
					<TimeRangeSelector
						value={timeRange}
						onChange={(value) => setTimeRange(value as TimeRange)}
					/>
				</div>

				{cache.data === undefined ? (
					cache.isError ? (
						<ErrorState
							title="Cache insights could not load"
							message={formatError(cache.error)}
							onRetry={() => void cache.refetch()}
						/>
					) : (
						<LoadingState label="Loading cache insights" />
					)
				) : (
					<CacheEfficiencyView data={cache.data} timeRange={timeRange} />
				)}
				{context.data === undefined ? (
					context.isError ? (
						<ErrorState
							title="Context insights could not load"
							message={formatError(context.error)}
							onRetry={() => void context.refetch()}
						/>
					) : (
						<LoadingState label="Loading context insights" />
					)
				) : (
					<ContextCompositionView data={context.data} timeRange={timeRange} />
				)}
				{anomaly.data === undefined ? (
					anomaly.isError ? (
						<ErrorState
							title="Anomaly insights could not load"
							message={formatError(anomaly.error)}
							onRetry={() => void anomaly.refetch()}
						/>
					) : (
						<LoadingState label="Loading anomaly insights" />
					)
				) : (
					<AnomaliesView data={anomaly.data} timeRange={timeRange} />
				)}
				<AlertsView />
			</div>
		</div>
	);
});

InsightsTab.displayName = "InsightsTab";
