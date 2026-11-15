import { AnalyticsTab } from "./AnalyticsTab";
import { LazyPage } from "./page-shell";

// Lazy loaded Analytics component for code splitting
export const LazyAnalytics = () => (
	<LazyPage page="analytics">
		<AnalyticsTab />
	</LazyPage>
);
