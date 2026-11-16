import { appliedDateRangeLabel } from "./request-date-range";

export type RequestFilterKey =
	| "account"
	| "agent"
	| "apiKey"
	| "status"
	| "date";

export interface ActiveRequestFilter {
	key: RequestFilterKey;
	label: string;
	value: string;
}

/**
 * The Requests filters that are on, in display order, each as "<label>: <value>".
 * The date value names the times the filter applies.
 */
export function activeRequestFilters(
	filters: {
		account: string;
		agent: string;
		/** Display name for `agent` when it is a session id. */
		agentLabel?: string;
		apiKey: string;
		statusCodes: ReadonlySet<string>;
		dateFrom: string;
		dateTo: string;
	},
	opts: { locale?: string; now?: number } = {},
): ActiveRequestFilter[] {
	const active: ActiveRequestFilter[] = [];
	if (filters.account !== "all") {
		active.push({ key: "account", label: "Account", value: filters.account });
	}
	if (filters.agent !== "all") {
		active.push({
			key: "agent",
			label: "Agent",
			value: filters.agentLabel ?? filters.agent,
		});
	}
	if (filters.apiKey !== "all") {
		active.push({
			key: "apiKey",
			label: "API key",
			value: filters.apiKey === "no-api-key" ? "none" : filters.apiKey,
		});
	}
	if (filters.statusCodes.size > 0) {
		active.push({
			key: "status",
			label: "Status",
			value: [...filters.statusCodes]
				.sort((a, b) => Number(a) - Number(b))
				.join(", "),
		});
	}
	if (filters.dateFrom || filters.dateTo) {
		active.push({
			key: "date",
			label: "Date",
			value: appliedDateRangeLabel(filters.dateFrom, filters.dateTo, opts),
		});
	}
	return active;
}
