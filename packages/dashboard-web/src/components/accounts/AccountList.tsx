import { registerUIRefresh } from "@hov-router/core";
import { AlertCircle, ChevronDown, Search, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { Account } from "../../api";
import { cn } from "../../lib/utils";
import { touchTargetClass } from "../ui/button";
import { AccountListItem } from "./AccountListItem";
import {
	ACCOUNT_SORTS,
	type AccountListSort,
	type AttentionReason,
	accountListView,
	accountNextReset,
} from "./account-list-view";
import type { AccountFamilyRoutingState } from "./account-routing";

interface AccountListProps {
	settingsErrors?: Readonly<Record<string, string | null>>;
	onClearSettingsError?: (accountId: string) => void;
	accounts: Account[] | undefined;
	routingByAccountId?: Readonly<
		Record<string, readonly AccountFamilyRoutingState[]>
	>;
	onPauseToggle: (account: Account) => void;
	onForceResetRateLimit: (account: Account) => void;
	onRefreshUsage: (account: Account) => Promise<string | null>;
	onRemove: (account: Account) => void;
	onRename: (account: Account) => void;
	onPriorityChange: (account: Account) => void;
	onAutoFallbackToggle: (account: Account) => void;
	onBillingTypeToggle: (account: Account) => void;
	onAutoPauseOnOverageToggle?: (account: Account) => void;
	onCodexCreditDrainToggle?: (account: Account) => void;
	onPublicValueToggle?: (account: Account) => void;
	onPublicValueEditLabel?: (account: Account) => void;
	onPeakHoursPauseToggle?: (account: Account) => void;
	onCustomEndpointChange?: (account: Account) => void;
	onModelMappingsChange?: (account: Account) => void;
	onReauth?: (account: Account) => void;
	onAnthropicReauth?: (account: Account) => void;
	onCodexReauth?: (account: Account) => void;
	onUseReset?: (account: Account) => void;
}

export function AccountList(props: AccountListProps) {
	const { accounts, routingByAccountId } = props;
	const [now, setNow] = useState(Date.now);
	const clockId = useId();
	useEffect(
		() =>
			registerUIRefresh({
				id: `account-list-status-${clockId}`,
				callback: () => setNow(Date.now()),
				seconds: 30,
				description: "Account status and attention expiry",
			}),
		[clockId],
	);
	const [sort, setSort] = useState<AccountListSort>("priority");
	const [search, setSearch] = useState("");
	const [attentionOnly, setAttentionOnly] = useState(false);
	const view = accountListView(
		accounts ?? [],
		{ search, attentionOnly, sort },
		routingByAccountId,
		now,
	);
	const filtered = search.trim() !== "" || view.attentionOnly;
	// Once nothing needs attention the view shows every account; drop the choice
	// too, so the next account that needs attention does not shrink the list.
	useEffect(() => {
		if (attentionOnly && !view.attentionOnly) setAttentionOnly(false);
	}, [attentionOnly, view.attentionOnly]);
	const clear = () => {
		setSearch("");
		setAttentionOnly(false);
	};
	if (!accounts)
		return (
			<p className="text-muted-foreground" role="status">
				Account data unavailable.
			</p>
		);
	if (accounts.length === 0) {
		return (
			<p className="text-muted-foreground">
				No accounts yet. Add one to start routing requests.
			</p>
		);
	}

	return (
		<div className="min-w-0 space-y-3">
			{view.counts.attention > 0 && (
				<AccountAttentionSummary
					count={view.counts.attention}
					reasons={view.attentionReasons}
					showingOnlyAttention={view.attentionOnly}
					onToggle={() => {
						setSearch("");
						setAttentionOnly(!view.attentionOnly);
					}}
				/>
			)}
			<div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center">
				<label className="relative flex min-w-0 flex-1 items-center">
					<Search
						aria-hidden="true"
						className="absolute left-3 h-4 w-4 text-muted-foreground"
					/>
					<span className="sr-only">Search accounts</span>
					<input
						type="search"
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						placeholder="Search name or provider"
						className="h-11 w-full min-w-0 rounded-md border bg-background pl-9 pr-11 text-sm"
					/>
					{search && (
						<button
							type="button"
							aria-label="Clear search"
							onClick={() => setSearch("")}
							className="absolute right-0 flex h-11 w-11 items-center justify-center"
						>
							<X className="h-4 w-4" />
						</button>
					)}
				</label>
				<label className="flex min-w-0 items-center gap-2 text-sm">
					<span>Sort</span>
					<select
						value={sort}
						onChange={(e) => setSort(e.target.value as AccountListSort)}
						className="h-11 min-w-0 rounded-md border bg-background px-2"
					>
						{ACCOUNT_SORTS.map(([value, label]) => (
							<option key={value} value={value}>
								{label}
							</option>
						))}
					</select>
				</label>
			</div>
			{/* The live region stays mounted so the count is announced when a filter starts. */}
			<div
				className={
					filtered
						? "flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground"
						: "sr-only"
				}
			>
				<p role="status">
					{filtered
						? `Showing ${view.accounts.length} of ${accounts.length} accounts`
						: ""}
				</p>
				{filtered && (
					<button
						type="button"
						onClick={clear}
						className={cn(
							touchTargetClass,
							"px-2 underline underline-offset-4",
						)}
					>
						Clear filters
					</button>
				)}
			</div>
			{sort !== "priority" && (
				<p className="text-xs text-muted-foreground">
					Sorting changes this view, not routing priority. The highlighted reset
					determines the order. Missing or past resets appear last.
				</p>
			)}
			{view.accounts.length === 0 && (
				<div className="rounded-lg border border-dashed p-6 text-center">
					<p className="font-medium">No matching accounts</p>
					<p className="mt-1 text-sm text-muted-foreground">
						Try another name or provider.
					</p>
				</div>
			)}
			<div className="overflow-hidden rounded-md border">
				<div
					aria-hidden="true"
					className="hidden grid-cols-[minmax(12.5rem,1.6fr)_minmax(0,3.2fr)_minmax(10rem,0.9fr)_14rem] gap-3 border-b bg-muted/20 px-3 py-3 text-xs text-muted-foreground xl:grid"
				>
					<span>Account</span>
					<span>Usage and resets</span>
					<span>Router status</span>
					<span>Actions</span>
				</div>
				{accountListItems({ ...props, accounts: view.accounts }, sort, now)}
			</div>
			<details className="group text-xs text-muted-foreground">
				<summary
					className={cn(
						touchTargetClass,
						"flex cursor-pointer list-none gap-x-2 [&::-webkit-details-marker]:hidden",
					)}
				>
					About usage and routing
					<ChevronDown
						aria-hidden="true"
						className="h-4 w-4 shrink-0 group-open:rotate-180"
					/>
				</summary>
				<p>
					Lower priority numbers route first among eligible accounts. Router
					status shows local blocks, not guaranteed provider capacity. Clear
					cooldown removes a router block; it does not reset provider usage. A
					provider reset and a router retry are separate timers. Missing usage
					is not zero or unlimited. Model-specific limits may run out before the
					account-wide limit. Manage model-family assignments and routing
					notices in Combos. The tick on a usage bar marks even pace: where
					usage would sit if the window's quota were spent evenly; usage well
					short of it near the reset is quota that expires unused.
				</p>
			</details>
		</div>
	);
}

const ATTENTION_REASON_TEXT: Record<AttentionReason, (n: number) => string> = {
	reconnect: (n) => `${n} to reconnect`,
	refused: (n) => `${n} refused by Anthropic`,
	payment: (n) => `${n} ${n === 1 ? "needs" : "need"} billing`,
	routing: (n) => `${n} routing decision${n === 1 ? "" : "s"} in Combos`,
};

/**
 * Accounts that need the operator to act, across all accounts. The button
 * switches the list between those accounts and every account.
 */
export function AccountAttentionSummary({
	count,
	reasons,
	showingOnlyAttention,
	onToggle,
}: {
	count: number;
	reasons: Readonly<Record<AttentionReason, number>>;
	showingOnlyAttention: boolean;
	onToggle: () => void;
}) {
	return (
		<section
			aria-label="Attention across all accounts"
			className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/20 px-3 py-2"
		>
			<div className="flex min-w-0 items-center gap-2">
				<AlertCircle
					aria-hidden="true"
					className="h-4 w-4 shrink-0 text-destructive"
				/>
				<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
					<p className="text-sm font-medium">
						{count} {count === 1 ? "needs" : "need"} attention
					</p>
					<p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
						{(Object.keys(ATTENTION_REASON_TEXT) as AttentionReason[])
							.filter((reason) => reasons[reason] > 0)
							.map((reason) => (
								<span key={reason}>
									{ATTENTION_REASON_TEXT[reason](reasons[reason])}
								</span>
							))}
					</p>
				</div>
			</div>
			<button
				type="button"
				className={cn(touchTargetClass, "px-3 text-sm")}
				onClick={onToggle}
			>
				{showingOnlyAttention ? "Show all accounts" : "Review accounts"}
			</button>
		</section>
	);
}

/** Keep immutable keys and routing lookup together when filters change. */
export function accountListItems(
	{
		settingsErrors,
		accounts,
		routingByAccountId,
		...handlers
	}: AccountListProps,
	sort: AccountListSort = "priority",
	now = Date.now(),
) {
	const rows = (accounts ?? []).map((account) => (
		<AccountListItem
			key={account.id}
			account={account}
			now={now}
			sortReset={
				sort === "next-reset" ? accountNextReset(account, now) : undefined
			}
			settingsError={settingsErrors?.[account.id]}
			routingStates={routingByAccountId?.[account.id]}
			isPrimary={account.isPrimary}
			{...handlers}
		/>
	));
	if (sort !== "priority") return rows;
	const counts = {
		active: (accounts ?? []).filter((account) => !account.paused).length,
		paused: (accounts ?? []).filter((account) => account.paused).length,
	};
	const seen = new Set<string>();
	return rows.flatMap((row, index) => {
		const group = accounts?.[index].paused ? "paused" : "active";
		if (seen.has(group)) return [row];
		seen.add(group);
		return [
			<h2
				key={`group:${group}`}
				className="border-b bg-muted/30 px-3 py-1.5 text-xs font-medium text-muted-foreground"
			>
				{group === "active" ? "Active" : "Paused"}{" "}
				<span className="tabular-nums">{counts[group]}</span>
				<span className="sr-only">
					{counts[group] === 1 ? " account" : " accounts"}
				</span>
			</h2>,
			row,
		];
	});
}
