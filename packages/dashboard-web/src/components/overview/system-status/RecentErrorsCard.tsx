import { NO_ACCOUNT_ID, type RecentErrorGroup } from "@hov-router/types";
import { useState } from "react";
import { useAccounts, useRecentErrors } from "../../../hooks/queries";
import { useApiError } from "../../../hooks/useApiError";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../../ui/select";
import { ErrorState } from "../../ui/state";
import { ErrorDetailsModal } from "./ErrorDetailsModal";
import { otherAccountsAvailable } from "./otherAccountsAvailable";
import { RecentErrorRow } from "./RecentErrorRow";
import { useDismissedErrors } from "./useDismissedErrors";
import { type ErrorWindowKey, useErrorWindow } from "./useErrorWindow";

const WINDOW_OPTIONS: Array<{ value: ErrorWindowKey; label: string }> = [
	{ value: "1h", label: "Last hour" },
	{ value: "24h", label: "Last 24 hours" },
	{ value: "7d", label: "Last 7 days" },
	{ value: "all", label: "Last year" },
];

export function RecentErrorsCard() {
	const { formatError } = useApiError();
	const { windowKey, setWindowKey, windowHours } = useErrorWindow();
	const {
		data: recentErrors,
		isError,
		error,
		refetch,
	} = useRecentErrors(windowHours);
	const { data: accounts } = useAccounts();
	const { dismiss, isDismissed } = useDismissedErrors();
	const [selectedError, setSelectedError] = useState<RecentErrorGroup | null>(
		null,
	);

	const visibleErrors = recentErrors?.filter((err) => !isDismissed(err)) ?? [];

	const hasOtherAvailableAccounts = (errorAccountId: string | null) =>
		otherAccountsAvailable(accounts, errorAccountId);

	// Loading and an empty list render nothing, as before; only a failed load with no data
	// shows a block, so it no longer looks the same as having no recent errors.
	if (recentErrors === undefined)
		return isError ? (
			<ErrorState
				size="inline"
				title="Recent errors could not load"
				message={formatError(error)}
				onRetry={() => void refetch()}
			/>
		) : null;
	if (visibleErrors.length === 0) return null;

	return (
		<div className="space-y-2">
			<div className="flex items-center justify-between">
				<h3 className="text-sm font-medium text-muted-foreground">
					Recent Errors
				</h3>
				<Select
					value={windowKey}
					onValueChange={(v) => setWindowKey(v as ErrorWindowKey)}
				>
					<SelectTrigger
						className="w-[140px] h-8 text-xs"
						aria-label="Error time window"
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{WINDOW_OPTIONS.map((option) => (
							<SelectItem key={option.value} value={option.value}>
								{option.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			<div className="space-y-2">
				{visibleErrors.map((error) => (
					<RecentErrorRow
						key={`${error.accountId ?? NO_ACCOUNT_ID}:${error.errorCode}:${error.latestRequestId}`}
						error={error}
						otherAccountsAvailable={hasOtherAvailableAccounts(error.accountId)}
						onClick={() => setSelectedError(error)}
						onDismiss={() => dismiss(error)}
					/>
				))}
			</div>

			<ErrorDetailsModal
				error={selectedError}
				otherAccountsAvailable={
					selectedError
						? hasOtherAvailableAccounts(selectedError.accountId)
						: false
				}
				onClose={() => setSelectedError(null)}
				onDismiss={(group) => dismiss(group)}
			/>
		</div>
	);
}
