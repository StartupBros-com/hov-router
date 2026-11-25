import { PRODUCT_NAME } from "@better-ccflare/core/product-identity";

export interface PageMeta {
	path: string;
	title: string;
	description: string;
}

/**
 * One title and description per page, in navigation order. The sidebar label,
 * the page heading and the loading fallback all read from here.
 */
export const PAGE_META = {
	overview: {
		path: "/",
		title: "Overview",
		description: `Monitor your ${PRODUCT_NAME} performance and usage`,
	},
	analytics: {
		path: "/analytics",
		title: "Analytics",
		description: "Usage patterns and trends over time",
	},
	alerts: {
		path: "/alerts",
		title: "Alerts",
		description:
			"Alerts on usage windows, cache health, account auth and routing",
	},
	requests: {
		path: "/requests",
		title: "Requests",
		description: "View detailed request and response data",
	},
	accounts: {
		path: "/accounts",
		title: "Accounts",
		description: "Provider accounts, usage limits and routing settings",
	},
	usageHistory: {
		path: "/usage-history",
		title: "Usage History",
		description: "Per-account usage windows over time, with limit prediction",
	},
	windowValue: {
		path: "/window-value",
		title: "Window Value",
		description: "Track the value of active and completed usage windows",
	},
	combos: {
		path: "/combos",
		title: "Combos",
		description: "Define fallback chains for model families",
	},
	routeLanes: {
		path: "/route-lanes",
		title: "Route Lanes",
		description: "Claude Code /model picker lanes, each pinned to an account",
	},
	agents: {
		path: "/agents",
		title: "Agents",
		description: "Discover and manage Claude Code agents",
	},
	keys: {
		path: "/keys",
		title: "API Keys",
		description: "Generate and manage API keys for authentication",
	},
	logs: {
		path: "/logs",
		title: "Logs",
		description: "Live system logs",
	},
	settings: {
		path: "/settings",
		title: "Settings",
		description: "Configure system behavior and data retention",
	},
} as const satisfies Record<string, PageMeta>;

export type PageKey = keyof typeof PAGE_META;

export function pageMetaForPath(pathname: string): PageMeta {
	return (
		Object.values(PAGE_META).find((page) => page.path === pathname) ??
		PAGE_META.overview
	);
}
