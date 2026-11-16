import {
	BarChart3,
	Boxes,
	ChevronRight,
	Gauge,
	RotateCcw,
	TriangleAlert,
} from "lucide-react";
import type { Account, RoutingObservation } from "../../api";
import { usePersistedExpansion } from "../../hooks/usePersistedExpansion";
import {
	bankedResetAccounts,
	type ForecastTone,
	forecastHeadline,
	type PoolGroup,
} from "../../lib/pool-forecast";
import { listObservedFamilies } from "../../lib/pool-usage";
import { cn } from "../../lib/utils";
import { resetActionAvailability } from "../accounts/reset-redemption-flow";
import { Button } from "../ui/button";
import { Card, CardContent } from "../ui/card";
import { EmptyState, ErrorState, LoadingState } from "../ui/state";
import { ObservedRoutingTable } from "./ObservedRoutingTable";
import { PoolRunway } from "./PoolRunway";

const STORAGE_KEY = "ccflare.poolCapacity.expanded";
const HIDDEN_LIST = new Intl.ListFormat("en", {
	style: "long",
	type: "conjunction",
});
const TONE_TEXT: Record<ForecastTone, string> = {
	"dry-now": "text-(--danger)",
	soon: "text-(--danger)",
	later: "text-foreground",
	lasts: "text-foreground",
	none: "text-muted-foreground",
};

function GroupIcon({
	group,
	className,
}: {
	group: PoolGroup;
	className?: string;
}) {
	const Icon =
		group.kind === "family"
			? Boxes
			: group.kind === "five_hour"
				? Gauge
				: BarChart3;
	return <Icon className={className} aria-hidden="true" />;
}

/** The left block of a pool row: what the pool is, then when it runs dry. */
function ForecastBlock({
	group,
	now,
	resets,
	onUseReset,
}: {
	group: PoolGroup;
	now: number;
	resets: Account[];
	onUseReset: (account: Account) => void;
}) {
	const summary = forecastHeadline(group, now);
	const alarm = summary.tone === "soon" || summary.tone === "dry-now";
	return (
		<div className="flex min-w-0 flex-col gap-1">
			<div className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
				<GroupIcon group={group} className="h-3.5 w-3.5 shrink-0" />
				<span className="font-medium text-foreground">{group.title}</span>
				<span aria-hidden="true">·</span>
				<span>{group.subtitle}</span>
			</div>
			<div
				className={cn(
					"flex items-start gap-1.5 text-lg font-semibold leading-snug",
					TONE_TEXT[summary.tone],
				)}
			>
				{alarm && (
					<TriangleAlert className="mt-1 h-4 w-4 shrink-0" aria-hidden="true" />
				)}
				<span>{summary.headline}</span>
			</div>
			<p className="text-sm text-muted-foreground">{summary.detail}</p>
			<p className="text-xs text-muted-foreground tabular-nums">
				{group.usedPct == null
					? "Usage unknown"
					: `${Math.round(group.usedPct)}% used across the pool`}
			</p>
			<BankedLever group={group} accounts={resets} onUseReset={onUseReset} />
		</div>
	);
}

/**
 * Which pool offers each banked reset: one button per account per card, in
 * the first red pool that lists it, so a Codex outage seen by both its weekly
 * and 5-hour pools does not offer the same irreversible action twice.
 */
function offeredResets(
	groups: PoolGroup[],
	now: number,
): Map<string, Account[]> {
	const offered = new Set<string>();
	const byGroup = new Map<string, Account[]>();
	for (const group of groups) {
		const accounts = bankedResetAccounts(group, now).filter(
			(a) => !offered.has(a.id),
		);
		for (const a of accounts) offered.add(a.id);
		byGroup.set(group.id, accounts);
	}
	return byGroup;
}

/** "Use a banked reset" beside a Codex dry warning. Gated on the held count only. */
function BankedLever({
	group,
	accounts,
	onUseReset,
}: {
	group: PoolGroup;
	accounts: Account[];
	onUseReset: (account: Account) => void;
}) {
	return accounts.map((account) => {
		const resets = account.bankedResets;
		if (!resets) return null;
		const availability = resetActionAvailability(resets);
		const noteId = `reset-note-${group.id}-${account.id}`;
		return (
			<div
				key={account.id}
				className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1"
			>
				<Button
					type="button"
					variant="outline"
					size="touch-sm"
					className="h-auto whitespace-normal text-left"
					disabled={!availability.enabled}
					aria-describedby={availability.note ? noteId : undefined}
					onClick={() => onUseReset(account)}
				>
					<RotateCcw className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
					<span>
						Use a banked reset on{" "}
						<span className="whitespace-nowrap">{account.name}</span>
					</span>
				</Button>
				<span className="text-xs text-muted-foreground tabular-nums">
					{resets.availableCount} held
				</span>
				{availability.note && (
					<p id={noteId} className="text-xs text-muted-foreground">
						{availability.note}
					</p>
				)}
			</div>
		);
	});
}
function CardFooter({
	hidden,
	hasCharts,
	observations,
	now,
}: {
	hidden: PoolGroup[];
	hasCharts: boolean;
	observations?: Record<string, RoutingObservation> | null;
	now: number;
}) {
	// Only when something was observed, so the disclosure never opens onto nothing.
	const hasObservations = listObservedFamilies(observations).length > 0;
	return (
		<div className="mt-2 flex flex-col gap-3 border-t pt-4 text-xs text-muted-foreground">
			{hidden.length > 0 && (
				<p>
					Not shown: {HIDDEN_LIST.format(hidden.map((g) => g.title))}. No
					account in {hidden.length === 1 ? "it" : "them"} reports when the
					limit resets.
				</p>
			)}
			{hasCharts && (
				<p className="max-w-prose">
					Forecast: each account keeps the pace it has averaged since its window
					opened, and traffic moves to accounts with quota left.
				</p>
			)}
			{hasObservations && (
				<details className="group/routing">
					<summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1.5 rounded-md text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
						<ChevronRight
							className="h-4 w-4 transition-transform group-open/routing:rotate-90"
							aria-hidden="true"
						/>
						Observed routing order
					</summary>
					<ObservedRoutingTable
						observations={observations}
						now={now}
						title="The last decision the proxy actually made, for each model family"
					/>
				</details>
			)}
		</div>
	);
}

export function PoolCapacitySection({
	groups,
	hidden,
	now,
	observations,
	loadError,
	loading,
	onUseReset,
}: {
	groups: PoolGroup[];
	hidden: PoolGroup[];
	now: number;
	observations?: Record<string, RoutingObservation> | null;
	loadError?: { message: string; onRetry: () => void } | null;
	loading?: boolean;
	onUseReset: (account: Account) => void;
}) {
	const { isExpanded, toggle } = usePersistedExpansion(STORAGE_KEY);
	const resets = offeredResets(groups, now);
	// A pool with no forecast is drawn as a plain list, not a chart.
	const hasCharts = groups.some((g) => g.forecast != null);
	if (loadError) {
		return (
			<Card>
				<CardContent className="p-6">
					<h3 className="mb-2 text-sm font-medium">Pool capacity</h3>
					<ErrorState
						size="inline"
						title="Pool capacity could not load"
						message={loadError.message}
						onRetry={loadError.onRetry}
					/>
					<ObservedRoutingTable observations={observations} now={now} />
				</CardContent>
			</Card>
		);
	}

	return (
		<Card>
			<CardContent className="p-4 sm:p-6">
				<div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
					<h3 className="text-sm font-medium">Pool capacity</h3>
					<span className="text-xs text-muted-foreground">
						Quota left over the next 7 days
					</span>
				</div>
				{loading ? (
					<LoadingState size="inline" label="Loading pool capacity" />
				) : (
					<>
						{hasCharts && (
							<p className="mb-1 max-w-prose text-xs text-muted-foreground">
								Each chart is the pool's quota left; the rows under it are its
								accounts, soonest reset first, each on its own 0–100% scale, so
								a jump is that account refilling. Red: nothing left in the pool.
								Past the dotted line (2 days out) the forecast is a rougher
								guess and is dashed.
							</p>
						)}
						{groups.length === 0 && hidden.length === 0 && (
							<EmptyState size="inline" title="No pool capacity yet." />
						)}
						{groups.map((group) => (
							<section
								key={group.id}
								aria-label={group.title}
								className="grid gap-4 border-t py-5 first:border-t-0 first:pt-2 lg:grid-cols-[15.5rem_1fr] lg:gap-5"
							>
								<ForecastBlock
									group={group}
									now={now}
									resets={resets.get(group.id) ?? []}
									onUseReset={onUseReset}
								/>
								<PoolRunway
									group={group}
									now={now}
									open={isExpanded(group.id)}
									onToggle={() => toggle(group.id)}
								/>
							</section>
						))}
						<CardFooter
							hidden={hidden}
							hasCharts={hasCharts}
							observations={observations}
							now={now}
						/>
					</>
				)}
			</CardContent>
		</Card>
	);
}
