import { useUsageWindows } from "../../hooks/queries";
import { useApiError } from "../../hooks/useApiError";
import { RoutePageHeader } from "../page-shell";
import { EmptyState, ErrorState, LoadingState } from "../ui/state";
import { WindowValueTimeline } from "./WindowValueTimeline";

/** Fleet usage-window timeline, grouped into provider sections. */
export function WindowValueTab() {
	const { data, error, isError, refetch } = useUsageWindows("all");
	const { formatError } = useApiError();
	const accounts = data && "accounts" in data ? data.accounts : [];
	const populatedAccounts = accounts.filter(
		(account) => account.openWindow !== null || account.windows.length > 0,
	);
	return (
		<div className="space-y-4">
			<RoutePageHeader page="windowValue" />
			{data === undefined ? (
				isError ? (
					<ErrorState
						title="Window values could not load"
						message={formatError(error)}
						onRetry={() => void refetch()}
					/>
				) : (
					<LoadingState label="Loading window values" />
				)
			) : populatedAccounts.length === 0 ? (
				<EmptyState
					title="No usage windows yet"
					description="Completed and live windows will appear here after usage is observed."
				/>
			) : (
				<WindowValueTimeline accounts={populatedAccounts} nowMs={Date.now()} />
			)}
		</div>
	);
}
