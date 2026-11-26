import { RoutePageHeader } from "../page-shell";
import { AlertsView } from "./AlertsView";

export function AlertsTab() {
	return (
		<div className="space-y-4">
			<RoutePageHeader page="alerts" />
			<AlertsView />
		</div>
	);
}
