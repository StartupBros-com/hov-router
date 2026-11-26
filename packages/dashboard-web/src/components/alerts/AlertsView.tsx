import type { AlertSeverity } from "@hov-router/types";
import { useQueryClient } from "@tanstack/react-query";
import {
	Check,
	CheckCheck,
	Info,
	type LucideIcon,
	OctagonAlert,
	TriangleAlert,
} from "lucide-react";
import React from "react";
import {
	useAcknowledgeAlert,
	useAcknowledgeAllAlerts,
	useAlerts,
} from "../../hooks/queries";
import { useAlertStream } from "../../hooks/useAlertStream";
import { useApiError } from "../../hooks/useApiError";
import {
	ALERTS_LIST_LIMIT,
	alertBadgeLabel,
	alertsNeedingAttention,
} from "../../lib/alert-attention";
import { queryKeys } from "../../lib/query-keys";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader } from "../ui/card";
import { EventTime } from "../ui/event-time";
import { EmptyState, ErrorState, LoadingState } from "../ui/state";
import { type PillTone, StatusPill } from "../ui/status-pill";

const SEVERITY: Record<
	AlertSeverity,
	{ label: string; tone: PillTone; icon: LucideIcon; iconClass: string }
> = {
	critical: {
		label: "Critical",
		tone: "danger",
		icon: OctagonAlert,
		iconClass: "text-(--danger)",
	},
	warning: {
		label: "Warning",
		tone: "warning",
		icon: TriangleAlert,
		iconClass: "text-(--warning)",
	},
	info: {
		label: "Info",
		tone: "info",
		icon: Info,
		iconClass: "text-(--info)",
	},
};

export const AlertsView = React.memo(() => {
	const queryClient = useQueryClient();
	const { data, dataUpdatedAt, isError, error, refetch } = useAlerts();
	const { formatError } = useApiError();
	const ack = useAcknowledgeAlert();
	const ackAll = useAcknowledgeAllAlerts();

	// Connect SSE stream and invalidate alerts query on new events.
	useAlertStream({
		onAlert: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.alerts() });
		},
	});

	if (data === undefined)
		return isError ? (
			<ErrorState
				title="Alerts could not load"
				message={formatError(error)}
				onRetry={() => void refetch()}
			/>
		) : (
			<LoadingState label="Loading alerts" />
		);

	const alerts = data.alerts;
	const unacknowledgedCount = data.unacknowledgedCount;
	const recent = alertBadgeLabel(
		alertsNeedingAttention(alerts, dataUpdatedAt, ALERTS_LIST_LIMIT),
	);

	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="space-y-0.5">
					<h3 className="text-lg font-medium">
						Unacknowledged: {unacknowledgedCount}
					</h3>
					<p className="text-sm text-muted-foreground">
						{recent === undefined
							? "No warning or critical alerts in the last 24 hours."
							: `Warning or critical in the last 24 hours: ${recent}. The nav badge shows this count.`}
					</p>
				</div>
				<Button
					size="sm"
					variant="outline"
					disabled={unacknowledgedCount === 0 || ackAll.isPending}
					onClick={() => void ackAll.mutateAsync()}
				>
					<CheckCheck className="h-4 w-4 mr-1" />
					Acknowledge all
				</Button>
			</div>

			{alerts.length === 0 ? (
				<EmptyState title="No alerts yet." />
			) : (
				<ul className="space-y-3">
					{alerts.map((alert) => {
						const severity = SEVERITY[alert.severity] ?? SEVERITY.warning;
						const Icon = severity.icon;
						return (
							<li key={alert.id}>
								<Card>
									<CardHeader>
										<div className="flex items-start justify-between gap-3">
											<div className="min-w-0 space-y-1">
												<div className="flex flex-wrap items-center gap-2">
													<Icon
														aria-hidden="true"
														className={`h-4 w-4 shrink-0 ${severity.iconClass}`}
													/>
													<span className="font-medium">{alert.title}</span>
													<StatusPill tone={severity.tone}>
														{severity.label}
													</StatusPill>
												</div>
												<p className="text-sm text-muted-foreground break-words">
													{alert.message}
												</p>
											</div>
											<Badge
												variant={alert.acknowledged ? "outline" : "destructive"}
											>
												{alert.acknowledged ? "Acknowledged" : "New"}
											</Badge>
										</div>
									</CardHeader>
									<CardContent className="pb-3 pt-0 flex items-center justify-between text-xs text-muted-foreground">
										<EventTime value={alert.timestamp} />
										<Button
											size="sm"
											variant="ghost"
											aria-label={`Acknowledge ${alert.title}`}
											disabled={alert.acknowledged || ack.isPending}
											onClick={() => void ack.mutateAsync(alert.id)}
										>
											<Check className="h-4 w-4 mr-1" />
											Acknowledge
										</Button>
									</CardContent>
								</Card>
							</li>
						);
					})}
				</ul>
			)}
		</div>
	);
});

AlertsView.displayName = "AlertsView";
