import { useSetUsageThrottling, useUsageThrottling } from "../../hooks/queries";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import { SwitchRow } from "../ui/switch-row";

export function UsageThrottlingCard() {
	const { data, isLoading } = useUsageThrottling();
	const setUsageThrottling = useSetUsageThrottling();

	const fiveHourEnabled = data?.fiveHourEnabled ?? false;
	const weeklyEnabled = data?.weeklyEnabled ?? false;

	return (
		<Card className="card-hover">
			<CardHeader>
				<CardTitle>Usage Throttling</CardTitle>
				<CardDescription>
					Control short-window and weekly pacing separately. When a selected
					window is ahead of its pacing line, the proxy returns an error
					instructing the client to retry in 60 seconds instead of sending
					another upstream request.
				</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="space-y-4">
					<div className="flex items-center gap-3">
						<SwitchRow
							className="flex-1"
							id="usage-throttling-five-hour"
							label="5-hour window"
							labelClassName="text-sm font-medium"
							description="Throttle requests when 5-hour usage is ahead of its pacing line."
							aria-label="5-hour window"
							disabled={isLoading || setUsageThrottling.isPending}
							checked={fiveHourEnabled}
							onCheckedChange={(checked) =>
								setUsageThrottling.mutate({
									fiveHourEnabled: checked,
									weeklyEnabled,
								})
							}
						/>
						<span className="text-sm text-muted-foreground">
							{fiveHourEnabled ? "Enabled" : "Disabled"}
						</span>
					</div>
					<div className="flex items-center gap-3">
						<SwitchRow
							className="flex-1"
							id="usage-throttling-weekly"
							label="Weekly window"
							labelClassName="text-sm font-medium"
							description="Throttle requests when weekly usage is ahead of its pacing line. Disable this if you expect usage to recover overnight."
							aria-label="Weekly window"
							disabled={isLoading || setUsageThrottling.isPending}
							checked={weeklyEnabled}
							onCheckedChange={(checked) =>
								setUsageThrottling.mutate({
									fiveHourEnabled,
									weeklyEnabled: checked,
								})
							}
						/>
						<span className="text-sm text-muted-foreground">
							{weeklyEnabled ? "Enabled" : "Disabled"}
						</span>
					</div>
				</div>
			</CardContent>
		</Card>
	);
}
