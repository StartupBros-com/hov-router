import { classifyAccountStatus } from "@hov-router/ui-common";
import type { Account } from "../../api";
import { providerShowsWeeklyUsage } from "../../utils/provider-utils";
import {
	type AccountFamilyRoutingState,
	routingNeedsReview,
} from "./account-routing";
import { accountUsageWindows } from "./account-usage-windows";
import { displayLabel } from "./rate-limit-helpers";
export const ACCOUNT_SORTS = [
	["priority", "Routing priority"],
	["next-reset", "Next reset (soonest)"],
] as const;
export type AccountListSort = (typeof ACCOUNT_SORTS)[number][0];
/** The account's soonest future window reset, which the next-reset sort orders by. */
export function accountNextReset(account: Account, now = Date.now()) {
	const { usages } = accountUsageWindows(
		{
			resetIso: account.rateLimitReset,
			usageUtilization: account.usageUtilization,
			usageWindow: account.usageWindow,
			usageData: account.usageData,
			provider: account.provider,
			showWeekly: providerShowsWeeklyUsage(account.provider),
			compact: true,
		},
		now,
	);
	return (
		usages
			.filter((row) => {
				const reset = row.resetTime ? Date.parse(row.resetTime) : NaN;
				return !!row.window && Number.isFinite(reset) && reset > now;
			})
			.map((row) => ({
				label: displayLabel(row),
				resetTime: row.resetTime ?? "",
				value: Date.parse(row.resetTime ?? ""),
			}))
			.sort((a, b) => a.value - b.value)[0] ?? null
	);
}

export type AttentionReason = "reconnect" | "refused" | "payment" | "routing";

/**
 * What the operator has to do for this account, if anything. A usage limit,
 * router cooldown, pacing or delayed usage poll clears on its own, and the
 * row's pill and bars already show it, so none of them counts here.
 */
function accountAttentionReason(
	account: Account,
	routing: readonly AccountFamilyRoutingState[] = [],
	now = Date.now(),
): AttentionReason | null {
	const status = classifyAccountStatus(account, now);
	if (status.reauth) return "reconnect";
	// Anthropic refusing the organization: billing or Claude Code access on claude.ai.
	if (status.reason === "refused") return "refused";
	// The provider wants payment (402): billing or credits for this account.
	if (status.reason === "payment") return "payment";
	if (routing.some(routingNeedsReview)) return "routing";
	return null;
}

export function needsAccountAttention(
	account: Account,
	routing: readonly AccountFamilyRoutingState[] = [],
	now = Date.now(),
): boolean {
	return accountAttentionReason(account, routing, now) !== null;
}

export function accountListView(
	accounts: readonly Account[],
	filters: {
		search?: string;
		attentionOnly?: boolean;
		sort?: AccountListSort;
	} = {},
	routing: Readonly<Record<string, readonly AccountFamilyRoutingState[]>> = {},
	now = Date.now(),
) {
	const search = filters.search?.trim().toLowerCase() ?? "";
	const attentionReasons: Record<AttentionReason, number> = {
		reconnect: 0,
		refused: 0,
		payment: 0,
		routing: 0,
	};
	let attention = 0;
	for (const account of accounts) {
		const reason = accountAttentionReason(account, routing[account.id], now);
		if (!reason) continue;
		attentionReasons[reason]++;
		attention++;
	}
	// Once nothing needs the operator, the attention view has nothing to show.
	const attentionOnly = !!filters.attentionOnly && attention > 0;
	return {
		counts: { all: accounts.length, attention },
		attentionReasons,
		attentionOnly,
		accounts: accounts
			.filter(
				(a) =>
					(!search ||
						`${a.name}\n${a.provider}`.toLowerCase().includes(search)) &&
					(!attentionOnly || needsAccountAttention(a, routing[a.id], now)),
			)
			.sort((a, b) => {
				const sort = filters.sort ?? "priority";
				// The router picks the lowest priority number among active accounts.
				// Names break ties so rows hold still between polls; Primary and
				// request counts change with every poll, so ordering never reads them.
				if (sort === "priority")
					return (
						Number(a.paused) - Number(b.paused) ||
						a.priority - b.priority ||
						a.name.toLowerCase().localeCompare(b.name.toLowerCase())
					);
				const left = accountNextReset(a, now)?.value;
				const right = accountNextReset(b, now)?.value;
				return left == null
					? right == null
						? 0
						: 1
					: right == null
						? -1
						: left - right;
			}),
	};
}
