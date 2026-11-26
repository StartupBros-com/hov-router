import { PRODUCT_NAME } from "@better-ccflare/core/product-identity";
import {
	AccountPresenter,
	type AccountStatusReason,
	formatClockTime,
} from "@better-ccflare/ui-common";
import {
	ChevronDown,
	CircleCheck,
	CirclePause,
	CircleX,
	Edit2,
	Ellipsis,
	Globe,
	Hash,
	KeyRound,
	Pause,
	Play,
	RefreshCw,
	Trash2,
	TriangleAlert,
	Zap,
} from "lucide-react";
import { useId, useState } from "react";
import type { Account } from "../../api";
import {
	providerShowsWeeklyUsage,
	providerSupportsAutoFeatures,
	providerSupportsCustomBilling,
} from "../../utils/provider-utils";
import { OAuthTokenStatusWithBoundary } from "../OAuthTokenStatus";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { StatusPill } from "../ui/status-pill";
import { Switch } from "../ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import {
	type AccountFamilyRoutingState,
	routingNeedsReview,
} from "./account-routing";
import { accountUsageWindows } from "./account-usage-windows";
import { BankedResetsStatus } from "./BankedResetsStatus";
import {
	ANTHROPIC_USAGE_SETTINGS_URL,
	type ExtraUsageStatus,
	extraUsageStatus,
} from "./extra-usage-status";
import { ProviderMark } from "./ProviderMark";
import { RateLimitProgress } from "./RateLimitProgress";
import {
	describeBindingConstraint,
	displayLabel,
	formatRateLimitStatus,
	formatUsagePercent,
} from "./rate-limit-helpers";
import { STATUS_PILL_TONE } from "./status-tones";

export { BankedResetsStatus } from "./BankedResetsStatus";

const STATUS_ICON = {
	ok: CircleCheck,
	warning: TriangleAlert,
	bad: CircleX,
	muted: CirclePause,
};

/**
 * Session totals older than this say when they were read. Under a slow
 * database the server answers each 60 s poll with its last read, so totals a
 * minute or two old are normal and stay unlabelled.
 */
const SESSION_TOTALS_SHOWN_AS_OLD_MS = 5 * 60_000;

function formatTokenCount(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

function formatPauseReason(reason: string | null): string | null {
	// Keep internal/future pause reasons private and safely renderable. Only
	// automatic pauses name their cause; a manual pause reads as plain "Paused".
	switch (reason) {
		case "overage":
			return "overage";
		default:
			return null;
	}
}

function formatRoutingFamily(family: string): string {
	return family.charAt(0).toUpperCase() + family.slice(1);
}

// The accounts API sends "-" (and some add-account responses "No active
// session") when nothing is active; neither carries information worth a slot.
const EMPTY_SESSION_INFO = new Set(["", "-", "No active session"]);

/** Label + switch pair used in the per-account settings row. */
const SETTING_CLASS =
	"flex min-h-11 min-w-0 flex-wrap content-start items-center gap-x-2 gap-y-1";
// Explicit dimensions avoid the switch's border shrinking an inset-based target.
const SETTING_SWITCH_CLASS =
	"relative after:absolute after:left-1/2 after:top-1/2 after:h-11 after:w-11 after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']";
// Clear cooldown: the standard small outline button, after the router retry
// time. Its 32px box reads as a button, not a text field. The tap area reaches
// 44px, 6px past each edge, which is no more than the status lines' 6px gap, so
// it never covers Re-authenticate or the usage block. 32px is the smallest box
// for which that holds, so no row needs an extra margin or stacking order.
const CLEAR_COOLDOWN_CLASS =
	"relative text-foreground after:absolute after:inset-x-0 after:top-1/2 after:h-11 after:-translate-y-1/2 after:content-['']";

/**
 * Codex-only usage extras (plan_type, credits_balance) come from the free
 * wham/usage poller and can be ABSENT from usageData at any moment -- live
 * traffic overwrites cached extras between polls. Not part of the public
 * FullUsageData union (see @better-ccflare/types), so every read here is
 * null-safe and simply omits the corresponding element when absent. Mirrors
 * the CodexUsageExtras cast in RateLimitProgress.tsx for the sibling
 * code_review_* extras.
 */
interface CodexUsageExtras {
	plan_type?: string | null;
	credits_balance?: number | null;
}

function getCodexUsageExtras(account: Account): CodexUsageExtras | null {
	if (account.provider !== "codex" || !account.usageData) return null;
	return account.usageData as CodexUsageExtras;
}

function routingAvailabilityOverlay(
	state: AccountFamilyRoutingState,
): { label: string; variant: "destructive" | "warning" } | null {
	if (state.availability === null) return null;
	switch (state.availability) {
		case "available":
			return null;
		case "paused":
			return { label: "Paused", variant: "warning" };
		case "requires_reauth":
			return { label: "Needs authentication", variant: "destructive" };
		case "rate_limited":
			return { label: "Rate limited", variant: "warning" };
		case "model_exhausted":
			return { label: "Model exhausted", variant: "warning" };
	}
}

// Statuses that already say the account takes no requests. Every model family
// is out along with it, so the row names none; Details still lists each family.
const ACCOUNT_BLOCKED_STATUS = new Set<AccountStatusReason>([
	"reauth",
	"paused",
	"refused",
	"payment",
	"cooldown",
	"exhausted",
	"hard-limit",
]);

interface AccountListItemProps {
	now?: number;
	sortReset?: { label: string; resetTime: string } | null;
	settingsError?: string | null;
	onClearSettingsError?: (accountId: string) => void;
	account: Account;
	routingStates?: readonly AccountFamilyRoutingState[];
	isPrimary?: boolean;
	onPauseToggle: (account: Account) => void;
	onForceResetRateLimit: (account: Account) => void;
	/** Resolves to the reason a refresh failed, or null when it did not. */
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
	/** Opens the Use reset confirmation; without it no button is shown. */
	onUseReset?: (account: Account) => void;
}

/**
 * Per-account Codex credit drain switch. Hook-free so tests can call it
 * directly and inspect the Switch props.
 */
export function CodexCreditDrainControl({
	account,
	onToggle,
}: {
	account: Account;
	onToggle: (account: Account) => void;
}) {
	return (
		<div className={SETTING_CLASS}>
			<span className="text-sm font-medium">Use purchased credits</span>
			<Switch
				className={SETTING_SWITCH_CLASS}
				checked={account.codexCreditDrainEnabled ?? false}
				aria-label={`Use purchased credits for ${account.name}`}
				onCheckedChange={() => onToggle(account)}
				title={`Lets ${PRODUCT_NAME} keep routing to this account after its plan window is spent, which spends purchased credits. Applies only while fresh usage data confirms credits are available.`}
			/>
			<p className="basis-full text-xs text-muted-foreground">
				Continue after the plan limit using purchased credits. This spends
				money.
			</p>
			{account.codexCreditDrainServing && (
				<span
					className="text-xs font-medium text-(--warning)"
					title="Plan window is spent; requests are being served from purchased credits"
				>
					on credits
				</span>
			)}
		</div>
	);
}

/**
 * Per-account "Public value" switch: publishes the account's API-equivalent
 * value on the public House of Vibe feed under a public label. Hook-free so
 * tests can call it directly and inspect the Switch props.
 */
export function PublicValueControl({
	account,
	onToggle,
	onEditLabel,
}: {
	account: Account;
	onToggle: (account: Account) => void;
	onEditLabel?: (account: Account) => void;
}) {
	const enabled = account.publicValueEnabled ?? false;
	return (
		<div className={SETTING_CLASS}>
			<span className="text-sm font-medium">Share value publicly</span>
			<Switch
				className={SETTING_SWITCH_CLASS}
				checked={enabled}
				aria-label={`Share value publicly for ${account.name}`}
				onCheckedChange={() => onToggle(account)}
				title="Publishes this account's subscription value on the public House of Vibe site under a public label (never the account name)."
			/>
			<p className="basis-full text-xs text-muted-foreground">
				Show subscription value on the public site under a separate public
				label.
			</p>
			{enabled && account.publicValueLabel && (
				<span
					className="text-xs font-medium"
					title="Public label shown on the House of Vibe site"
				>
					{account.publicValueLabel}
				</span>
			)}
			{enabled && onEditLabel && (
				<Button
					variant="ghost"
					size="touch-icon"
					onClick={() => onEditLabel(account)}
					aria-label="Edit public label"
					title="Edit public label"
				>
					<Edit2 className="h-3 w-3" />
				</Button>
			)}
		</div>
	);
}

/**
 * A Claude login's extra-usage state, its warning while the state reads on,
 * and each hold in full, for Details > Settings beside the switch. The
 * collapsed row carries only the pill and the hold cues.
 */
function ExtraUsageDetails({ status }: { status: ExtraUsageStatus }) {
	return (
		<div className="basis-full space-y-1 text-xs">
			<p className="text-muted-foreground">
				{status.stateLine}{" "}
				<a
					href={ANTHROPIC_USAGE_SETTINGS_URL}
					target="_blank"
					rel="noopener noreferrer"
					className="text-primary-text underline"
				>
					Change at claude.ai
				</a>
			</p>
			{status.warning && <p>{status.warning}</p>}
			{status.holds.length > 0 && (
				<ul className="space-y-1" aria-label="Extra-usage holds">
					{status.holds.map((hold) => (
						<li key={hold.key}>
							<span className="font-medium">Held: {hold.held}</span> —{" "}
							{hold.why}. {hold.ends}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

export function AccountListItem({
	now = Date.now(),
	sortReset,
	settingsError,
	onClearSettingsError,
	account,
	routingStates = [],
	isPrimary = false,
	onPauseToggle,
	onForceResetRateLimit,
	onRefreshUsage,
	onRemove,
	onRename,
	onPriorityChange,
	onAutoFallbackToggle,
	onBillingTypeToggle,
	onAutoPauseOnOverageToggle,
	onCodexCreditDrainToggle,
	onPublicValueToggle,
	onPublicValueEditLabel,
	onPeakHoursPauseToggle,
	onCustomEndpointChange,
	onModelMappingsChange,
	onReauth,
	onAnthropicReauth,
	onCodexReauth,
	onUseReset,
}: AccountListItemProps) {
	const [isRefreshingUsage, setIsRefreshingUsage] = useState(false);
	const [detailsOpen, setDetailsOpen] = useState(false);
	const detailsId = useId();
	const [detailsTab, setDetailsTab] = useState("usage");
	const [refreshError, setRefreshError] = useState<string | null>(null);
	const refreshUsage = async () => {
		setIsRefreshingUsage(true);
		try {
			setRefreshError(await onRefreshUsage(account));
		} finally {
			setIsRefreshingUsage(false);
		}
	};
	const changeDetailsOpen = (open: boolean) => {
		onClearSettingsError?.(account.id);
		setDetailsOpen(open);
	};
	const quietBankedBalance =
		account.provider === "codex" &&
		account.bankedResets?.tracked &&
		account.bankedResets.availableCount === 0 &&
		!account.bankedResets.stale;
	const presenter = new AccountPresenter(account, now);
	const status = presenter.status;
	const extraUsage = extraUsageStatus(account, now);
	const StatusIcon = STATUS_ICON[status.tone];
	// Display-only: the window actually closest to blocking this account,
	// including per-model caps that the routing utilization deliberately omits.
	const bindingConstraint = describeBindingConstraint(
		account.bindingConstraint,
		account.usageWindow,
	);
	const reauthRequired = status.reauth;
	const showForceReset = status.clearCooldown;
	// staleLockDetected only fires when numeric usage data exists (Anthropic accounts);
	// Zai/NanoGPT accounts have usageUtilization === null and are correctly excluded
	// A 402 is a billing failure, not a usage limit, so usage under 100% says
	// nothing about it.
	const staleLockDetected =
		showForceReset &&
		status.reason !== "payment" &&
		typeof account.usageUtilization === "number" &&
		account.usageUtilization < 100;
	const codexUsageExtras = getCodexUsageExtras(account);
	const codexCreditsBalance =
		typeof codexUsageExtras?.credits_balance === "number" &&
		codexUsageExtras.credits_balance > 0
			? codexUsageExtras.credits_balance
			: null;

	// Parse Bedrock profile and region from custom_endpoint
	let bedrockProfile: string | null = null;
	let bedrockRegion: string | null = null;
	let bedrockCrossRegionMode: string | null = null;
	if (account.provider === "bedrock" && account.customEndpoint) {
		const match = account.customEndpoint.match(/^bedrock:([^:]+):(.+)$/);
		if (match) {
			bedrockProfile = match[1];
			bedrockRegion = match[2];
		}
		bedrockCrossRegionMode = account.crossRegionMode || "geographic";
	}

	const pauseReasonLabel = formatPauseReason(account.pauseReason);
	const sessionInfo = presenter.sessionInfo;
	const showSessionInfo = !EMPTY_SESSION_INFO.has(sessionInfo);
	const modelMappingCount = account.modelMappings
		? Object.keys(account.modelMappings).length
		: 0;
	const canRefreshUsage =
		account.provider === "anthropic" || account.provider === "codex";
	// One re-authentication path per provider, same gates as before.
	const reauth =
		account.provider === "qwen" && onReauth
			? {
					handler: onReauth,
					title: "Re-authenticate this Qwen account (preserves all metadata)",
				}
			: account.provider === "anthropic" &&
					account.hasRefreshToken &&
					onAnthropicReauth
				? {
						handler: onAnthropicReauth,
						title:
							"Re-authenticate this Anthropic account (preserves all metadata)",
					}
				: account.provider === "codex" && onCodexReauth
					? {
							handler: onCodexReauth,
							title:
								"Re-authenticate this Codex account (preserves all metadata)",
						}
					: null;
	const reauthShown = Boolean(reauth && reauthRequired);
	const rateLimitProgressProps = {
		resetIso: account.rateLimitReset,
		usageUtilization: account.usageUtilization,
		usageWindow: account.usageWindow,
		usageData: account.usageData,
		usageRateLimitedUntil: account.usageRateLimitedUntil,
		usageThrottledUntil: account.usageThrottledUntil,
		usageThrottledWindows: account.usageThrottledWindows,
		provider: account.provider,
		showWeekly: providerShowsWeeklyUsage(account.provider),
	};

	const visibleWindows = accountUsageWindows({
		...rateLimitProgressProps,
		compact: true,
	}).usages;
	// A held window's cue already says it is spent, and until when.
	const heldWindows = new Set(extraUsage?.holds.map((hold) => hold.windowKey));
	const isSpent = (row: (typeof visibleWindows)[number]) =>
		!row.synthetic &&
		typeof row.utilization === "number" &&
		row.utilization >= 100;
	const spentWindows = new Set(
		visibleWindows.filter(isSpent).map((row) => row.window),
	);
	// A ready account can still have one window spent (often a per-model cap).
	const fullWindowLabels =
		status.reason === "normal"
			? visibleWindows
					.filter((row) => isSpent(row) && !heldWindows.has(row.window))
					.map(displayLabel)
			: [];
	// A family the router skips while the account still routes. Its own weekly
	// bar says so when that bar is full or held, keyed by window id, never label.
	const spentFamilyLabels = ACCOUNT_BLOCKED_STATUS.has(status.reason)
		? []
		: [
				...new Set(
					routingStates
						.filter(
							(state) =>
								state.availability === "model_exhausted" &&
								!spentWindows.has(`seven_day_${state.family}`) &&
								!heldWindows.has(`seven_day_${state.family}`),
						)
						.map((state) => formatRoutingFamily(state.family)),
				),
			];
	const atLimitLabels = [...fullWindowLabels, ...spentFamilyLabels];
	// Match the exact window, scope, value and reset. A same-named limit with
	// different observations must retain its exception instead of disappearing.
	const representedBinding = visibleWindows.find((row) => {
		const constraint = account.bindingConstraint;
		return (
			constraint &&
			!row.synthetic &&
			row.window === constraint.window &&
			row.utilization === constraint.utilization &&
			(row.resetTime ? Date.parse(row.resetTime) : null) ===
				constraint.resetAtMs &&
			(constraint.scope === "family") ===
				!!row.window?.startsWith("seven_day_") &&
			displayLabel(row) === bindingConstraint?.label
		);
	});
	const showAutoFeatures = providerSupportsAutoFeatures(account.provider);
	const showPlanBilling = providerSupportsCustomBilling(account.provider);
	const showAutoPause =
		account.provider === "anthropic" && Boolean(onAutoPauseOnOverageToggle);
	const showCreditDrain =
		account.provider === "codex" && Boolean(onCodexCreditDrainToggle);
	const showPeakHoursPause =
		account.provider === "zai" && Boolean(onPeakHoursPauseToggle);
	const hasSettings =
		showAutoFeatures ||
		showPlanBilling ||
		showAutoPause ||
		showCreditDrain ||
		Boolean(onPublicValueToggle) ||
		showPeakHoursPause ||
		extraUsage !== null;

	return (
		<article
			aria-label={account.name}
			className={`min-w-0 space-y-3 border-b bg-card px-3 py-3 transition-colors [overflow-wrap:anywhere] xl:grid xl:grid-cols-[minmax(12.5rem,1.6fr)_minmax(0,3.2fr)_minmax(10rem,0.9fr)_14rem] xl:items-start xl:gap-3 xl:space-y-0 ${
				// The Primary marker is an inset shadow, not a border, so every row
				// keeps the column header's content box and names share one edge.
				isPrimary
					? "border-border shadow-[inset_2px_0_0_var(--color-primary)]"
					: "border-border hover:border-muted-foreground/50"
			}`}
		>
			{/* Identity on the left, actions on the right. The identity column claims
			    the full phone row, so on a narrow card the actions drop below the name
			    instead of squeezing it into a sliver. */}
			<div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 xl:contents">
				<div className="grid min-w-0 basis-full grid-cols-[1rem_minmax(0,1fr)] gap-x-2 gap-y-1 sm:basis-auto sm:flex-[1_1_8rem] xl:col-start-1 xl:row-start-1">
					{/* The name line holds only the name and its token health, so the
					    icon never wraps away from the name it describes. */}
					<div className="col-start-1 row-start-1 self-center">
						<ProviderMark provider={account.provider} />
					</div>
					<div className="col-start-2 row-start-1 flex min-w-0 items-center">
						<h3 className="min-w-0 break-words font-medium leading-tight">
							{account.name}
						</h3>
						<OAuthTokenStatusWithBoundary
							accountName={account.name}
							hasRefreshToken={account.hasRefreshToken}
							provider={account.provider}
						/>
					</div>
					{/* No bullet separators: they strand at line ends when this wraps.
					    The pills overhang the text line by 2px each way instead of
					    making it taller, so every row's actions sit at one height;
					    the 6px line gap keeps pills on wrapped lines apart. */}
					<div className="col-start-2 row-start-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
						<span className="inline-flex items-center gap-1.5">
							{account.provider}
						</span>
						{codexUsageExtras?.plan_type && (
							<StatusPill tone="secondary" className="-my-0.5">
								{codexUsageExtras.plan_type}
							</StatusPill>
						)}
						<span className="whitespace-nowrap tabular-nums">
							Priority {account.priority}
						</span>
						{isPrimary && (
							<StatusPill
								tone="primary"
								className="-my-0.5"
								title="The account the router picks next"
							>
								Primary
							</StatusPill>
						)}
					</div>
				</div>
				{/* Refresh, Pause, Details and More hold one place on every row. Wide
				    rows are top-aligned, and the 44px buttons rise 12px to centre on
				    the name's line. */}
				<div className="ml-auto flex shrink-0 flex-wrap items-center gap-1 min-w-0 max-w-full justify-end xl:col-start-4 xl:row-start-1 xl:-my-3">
					{canRefreshUsage && (
						<Button
							variant="ghost"
							size="touch-icon"
							disabled={isRefreshingUsage}
							onClick={refreshUsage}
							aria-label={`Refresh usage for ${account.name}`}
							title={
								account.provider === "codex"
									? "Refresh usage data (free ChatGPT usage endpoint; falls back to a minimal quota-consuming request on custom endpoints or when the free endpoint fails)"
									: "Refresh usage data (restarts usage polling and refreshes token if expired)"
							}
						>
							<RefreshCw
								aria-hidden="true"
								className={`h-4 w-4 motion-reduce:animate-none ${isRefreshingUsage ? "animate-spin" : ""}`}
							/>
						</Button>
					)}
					<Button
						variant="ghost"
						size="touch-icon"
						disabled={account.paused && !status.canResume}
						onClick={() => {
							if (!account.paused || status.canResume) onPauseToggle(account);
						}}
						aria-label={`${account.paused ? "Resume" : "Pause"} ${account.name}`}
						title={`${account.paused ? "Resume" : "Pause"} ${account.name}`}
					>
						{account.paused ? (
							<Play className="h-4 w-4" />
						) : (
							<Pause className="h-4 w-4" />
						)}
					</Button>
					<Button
						variant={detailsOpen ? "secondary" : "ghost"}
						size="touch-sm"
						className="gap-1 px-2"
						aria-label={`Details for ${account.name}`}
						aria-expanded={detailsOpen}
						aria-controls={detailsId}
						onClick={() => changeDetailsOpen(!detailsOpen)}
					>
						Details
						<ChevronDown
							className={`h-4 w-4 ${detailsOpen ? "rotate-180" : ""}`}
							aria-hidden="true"
						/>
					</Button>
					{/* A non-modal menu can hand focus to the existing confirmation dialogs. */}
					<DropdownMenu modal={false}>
						<DropdownMenuTrigger asChild>
							<Button
								variant="ghost"
								size="touch-icon"
								aria-label={`More actions for ${account.name}`}
								title="More actions"
							>
								<Ellipsis className="h-4 w-4" />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="w-52">
							<DropdownMenuItem
								className="min-h-11 gap-2"
								onSelect={() => onRename(account)}
							>
								<Edit2 className="h-4 w-4" />
								Rename…
							</DropdownMenuItem>
							<DropdownMenuItem
								className="min-h-11 gap-2"
								onSelect={() => onPriorityChange(account)}
							>
								<Zap className="h-4 w-4" />
								Change priority…
							</DropdownMenuItem>
							{onCustomEndpointChange && (
								<DropdownMenuItem
									className="min-h-11 gap-2"
									onSelect={() => onCustomEndpointChange(account)}
								>
									<Globe className="h-4 w-4" />
									Custom endpoint…
								</DropdownMenuItem>
							)}
							{onModelMappingsChange && (
								<DropdownMenuItem
									className="min-h-11 gap-2"
									onSelect={() => onModelMappingsChange(account)}
								>
									<Hash className="h-4 w-4" />
									Model mappings…
								</DropdownMenuItem>
							)}
							{reauth && !reauthRequired && (
								<DropdownMenuItem
									className="min-h-11 gap-2"
									onSelect={() => reauth.handler(account)}
								>
									<KeyRound className="h-4 w-4" />
									Re-authenticate…
								</DropdownMenuItem>
							)}
							<DropdownMenuSeparator />
							<DropdownMenuItem
								className="min-h-11 gap-2 text-destructive focus:text-destructive"
								onSelect={() => onRemove(account)}
							>
								<Trash2 className="h-4 w-4" />
								Remove account…
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			</div>

			{/* Concise local status; diagnostics and request totals live in Details. */}
			<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-sm [&>span]:max-w-full [&>span]:whitespace-normal xl:col-start-3 xl:row-start-1 xl:flex-col xl:items-start">
				<span className="text-xs font-medium text-muted-foreground xl:sr-only">
					Router status
				</span>
				<StatusPill
					tone={STATUS_PILL_TONE[status.tone]}
					title={
						reauthRequired
							? "Refresh token invalid — re-authenticate"
							: status.reason === "pacing"
								? "Pacing may apply to specific model windows, not every request."
								: status.weeklyLimitNotice
									? `${status.weeklyLimitNotice.window} use is ${Math.round(status.weeklyLimitNotice.percent)}%. Requests still route here.`
									: status.notices.includes("soft-warning")
										? `Provider reported ${status.reportedStatus}. Requests still route here.`
										: status.notices.includes("usage-refresh")
											? "Usage refresh delayed; the usage shown may be out of date."
											: undefined
					}
				>
					<StatusIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
					{/* The status track's 10rem floor fits the longest label on one line. */}
					<span className="whitespace-nowrap">{status.label}</span>
				</StatusPill>
				{reauth && reauthShown && (
					<Button
						variant="default"
						size="touch-sm"
						className="gap-1 text-xs text-black hover:text-black"
						onClick={() => reauth.handler(account)}
						title={reauth.title}
					>
						<KeyRound className="h-4 w-4" />
						Re-authenticate
					</Button>
				)}
				{status.reason === "paused" && pauseReasonLabel && (
					<span className="text-xs text-muted-foreground">
						{`Auto-paused: ${pauseReasonLabel}`}
					</span>
				)}
				{status.hint && (
					<span className="text-xs text-muted-foreground">{status.hint}</span>
				)}
				{atLimitLabels.length > 0 && (
					<span className="text-xs text-muted-foreground">
						{`${atLimitLabels.join(", ")} at limit`}
					</span>
				)}
				{extraUsage?.holds.map(
					(hold) =>
						hold.cue && (
							<span key={hold.key} className="text-xs text-muted-foreground">
								{hold.cue}
							</span>
						),
				)}
				{/* State, then why, then when, then the fix. */}
				{staleLockDetected && (
					<StatusPill
						tone="warning"
						title="Reported usage is below 100%, but the router still has a rate-limit block."
					>
						Possible stale cooldown
					</StatusPill>
				)}
				{(status.routerRetryAt != null || showForceReset) && (
					<span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
						{status.routerRetryAt != null && (
							<span
								title={new Date(
									account.rateLimitedUntil as number,
								).toLocaleString()}
							>
								Router retry{" "}
								{formatClockTime(
									Math.ceil((account.rateLimitedUntil as number) / 60_000) *
										60_000,
									now,
								)}
							</span>
						)}
						{showForceReset && (
							<Button
								variant="outline"
								size="sm"
								className={CLEAR_COOLDOWN_CLASS}
								onClick={() => onForceResetRateLimit(account)}
								aria-label={`Clear cooldown for ${account.name}`}
								title="Clear the router’s saved rate-limit state. Provider usage limits are unchanged."
							>
								Clear cooldown
							</Button>
						)}
					</span>
				)}
				{extraUsage?.state === "on" && (
					<StatusPill tone="warning" title={extraUsage.warning ?? undefined}>
						Extra usage on
					</StatusPill>
				)}

				{codexCreditsBalance !== null && (
					<span className="whitespace-nowrap tabular-nums text-muted-foreground">
						{codexCreditsBalance.toLocaleString()} credits
					</span>
				)}
				{account.codexCreditDrainServing && account.provider === "codex" && (
					<StatusPill tone="warning">Serving from purchased credits</StatusPill>
				)}
			</div>

			{/* The container for the compact bars' layout. */}
			<div className="@container min-w-0 border-t pt-3 xl:col-start-2 xl:row-start-1 xl:border-t-0 xl:pt-0">
				<RateLimitProgress
					compact
					bindingWindow={representedBinding?.window}
					highlightReset={sortReset}
					{...rateLimitProgressProps}
				/>
				{account.provider === "codex" &&
					account.bankedResets &&
					!quietBankedBalance && (
						<div className="mt-1">
							<BankedResetsStatus
								compact
								resets={account.bankedResets}
								accountName={account.name}
								onUseReset={onUseReset ? () => onUseReset(account) : undefined}
							/>
						</div>
					)}
				{refreshError && (
					<p role="alert" className="mt-1 text-xs text-destructive">
						{refreshError}
					</p>
				)}
			</div>

			{/* Only decisions for Combos get a line here; whether a family is
			    available shows once, in the status column and Details. */}
			{routingStates.some(routingNeedsReview) && (
				<section
					className="space-y-1 text-sm xl:col-span-full"
					aria-label="Routing notices"
				>
					{routingStates.filter(routingNeedsReview).map((state) => (
						<p
							key={`${state.family}:${state.comboId}`}
							className="text-(--warning)"
						>
							{`${formatRoutingFamily(state.family)}: ${[
								(state.reason === "ambiguous" ||
									state.reason === "new_billing_class") &&
									`Action required — ${state.reasonLabel}. Review in Combos.`,
								state.managedRouteAvailable &&
									"Managed route available — Review in Combos.",
							]
								.filter(Boolean)
								.join(" ")}`}
						</p>
					))}
				</section>
			)}

			{bindingConstraint && !representedBinding && (
				// Deliberately NOT a replacement for the routing utilization badge
				// above: routing asks how much account-wide capacity is left, this
				// asks what is actually stopping you. Collapsing the two is what let
				// a 100% model-scoped cap hide behind a 64% account-wide badge.
				<div
					className="text-xs text-muted-foreground xl:col-span-full"
					data-testid="binding-constraint"
				>
					{bindingConstraint.divergesFromRouting ? (
						<>
							Closest limit: {bindingConstraint.label}{" "}
							{formatUsagePercent(bindingConstraint.utilization)}
							{bindingConstraint.scope === "family"
								? " used — applies to this model, separate from account-wide usage"
								: " used — a different window from the routing limit"}
						</>
					) : (
						<>
							Closest limit: {bindingConstraint.label}{" "}
							{formatUsagePercent(bindingConstraint.utilization)} used —
							account-wide
						</>
					)}
				</div>
			)}

			<section
				id={detailsId}
				aria-label={`Details for ${account.name}`}
				hidden={!detailsOpen}
				className="min-w-0 border-t pt-3 xl:col-span-full"
			>
				{detailsOpen && (
					<Tabs
						value={detailsTab}
						onValueChange={setDetailsTab}
						className="min-w-0"
					>
						{settingsError && (
							<p role="alert" className="mb-3 text-sm text-destructive">
								{settingsError}
							</p>
						)}
						<TabsList
							aria-label={`Account details for ${account.name}`}
							className="h-auto min-h-11 w-full justify-start rounded-none border-b bg-transparent p-0 sm:w-auto"
						>
							{["usage", "routing", "settings"].map((tab) => (
								<TabsTrigger
									key={tab}
									value={tab}
									className="min-h-11 flex-1 rounded-none border-b-2 border-transparent px-4 capitalize data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none sm:flex-none"
								>
									{tab}
								</TabsTrigger>
							))}
						</TabsList>

						<TabsContent value="usage" className="max-w-4xl space-y-4 py-3">
							<div className="flex flex-wrap items-center gap-3 text-sm">
								<span className="tabular-nums">
									{presenter.requestCount.toLocaleString()} requests
								</span>
								<Button
									size="touch"
									variant="outline"
									disabled={account.paused && !status.canResume}
									onClick={() => {
										if (!account.paused || status.canResume)
											onPauseToggle(account);
									}}
								>
									{account.paused ? "Resume account" : "Pause account"}
								</Button>
							</div>
							<p
								className="text-xs text-muted-foreground"
								title={presenter.rateLimitStatus}
							>
								Reported limit status:{" "}
								{formatRateLimitStatus(presenter.rateLimitStatus)}
							</p>
							{account.provider === "codex" && account.bankedResets && (
								<BankedResetsStatus
									resets={account.bankedResets}
									accountName={account.name}
									onUseReset={
										onUseReset ? () => onUseReset(account) : undefined
									}
								/>
							)}
							<RateLimitProgress {...rateLimitProgressProps} />
							<p className="text-xs text-muted-foreground">
								The comparison shows reported quota windows. An absent window is
								not zero usage or unlimited capacity; provider reset times are
								separate from local retry delays.
							</p>
							{showSessionInfo && (
								<span className="tabular-nums text-muted-foreground">
									{sessionInfo}
								</span>
							)}
							{account.sessionStatsUnavailable && !account.sessionStats && (
								<p className="text-xs text-muted-foreground">
									Session totals unavailable right now. They return once the
									database answers.
								</p>
							)}
							{account.sessionStats && (
								<div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
									<span className="font-medium">Session</span>
									{account.sessionStatsAsOf != null &&
										now - account.sessionStatsAsOf >=
											SESSION_TOTALS_SHOWN_AS_OLD_MS && (
											<span
												title={new Date(
													account.sessionStatsAsOf,
												).toLocaleString()}
											>
												as of {formatClockTime(account.sessionStatsAsOf, now)}
											</span>
										)}
									<span>{account.sessionStats.requests} requests</span>
									<span>
										{formatTokenCount(account.sessionStats.inputTokens)} in
									</span>
									<span>
										{formatTokenCount(
											account.sessionStats.cacheCreationInputTokens,
										)}{" "}
										cache write
									</span>
									<span>
										{formatTokenCount(
											account.sessionStats.cacheReadInputTokens,
										)}{" "}
										cache read
									</span>
									<span>
										{formatTokenCount(account.sessionStats.outputTokens)} out
									</span>
									{account.sessionStats.planCostUsd > 0 && (
										<span>
											${account.sessionStats.planCostUsd.toFixed(2)} plan
										</span>
									)}
									{account.sessionStats.apiCostUsd > 0 && (
										<span>
											${account.sessionStats.apiCostUsd.toFixed(2)} API
										</span>
									)}
								</div>
							)}
						</TabsContent>
						<TabsContent value="routing" className="space-y-4 py-3">
							{routingStates.length > 0 && (
								<section
									aria-label={`Family routing for ${account.name}`}
									className="group space-y-2"
								>
									<h4 className="text-sm font-medium">Model-family routes</h4>
									<div className="flex flex-wrap gap-2">
										{routingStates.map((state) => {
											const availability = routingAvailabilityOverlay(state);
											const actionRequired =
												state.reason === "ambiguous" ||
												state.reason === "new_billing_class";
											const reasonDuplicatesMembership =
												state.membershipLabel === "Manual" &&
												state.reason === "manual_override";

											return (
												<div
													key={`${state.family}:${state.comboId ?? "none"}`}
													className="flex flex-wrap items-center gap-1.5 rounded-md border bg-muted/20 px-2 py-1.5 text-xs"
												>
													<Badge variant="outline">
														{formatRoutingFamily(state.family)}
													</Badge>
													{state.membershipLabel && (
														<Badge
															variant={
																state.membershipLabel === "Managed"
																	? "outline"
																	: "secondary"
															}
														>
															{state.membershipLabel}
														</Badge>
													)}
													{state.logicalModel && (
														<span>{state.logicalModel}</span>
													)}
													{state.tier !== null && (
														<span>Tier {state.tier}</span>
													)}
													{state.reasonLabel && !reasonDuplicatesMembership && (
														<span className="text-muted-foreground">
															{state.reasonLabel}
														</span>
													)}
													{actionRequired && (
														<StatusPill tone="warning">
															Action required
														</StatusPill>
													)}
													{state.managedRouteAvailable && (
														<>
															<StatusPill tone="warning">
																Managed route available
															</StatusPill>
															<span className="text-muted-foreground">
																Review in Combos
															</span>
														</>
													)}
													{availability && (
														<>
															<Badge
																variant={availability.variant}
																title={state.availabilityLabel ?? undefined}
															>
																{availability.label}
															</Badge>
															<span className="text-muted-foreground">
																route assignment unchanged
															</span>
														</>
													)}
												</div>
											);
										})}
									</div>
								</section>
							)}
							<div className="flex min-w-0 flex-wrap gap-3 text-xs text-muted-foreground">
								{" "}
								{account.provider === "bedrock" && bedrockProfile && (
									<>
										<span className="whitespace-nowrap">
											Profile: {bedrockProfile}
										</span>
										{bedrockRegion && (
											<span
												className="inline-flex items-center gap-1 whitespace-nowrap"
												title={`Region: ${bedrockRegion}`}
											>
												<Globe className="h-3 w-3" />
												{bedrockRegion}
											</span>
										)}
										{bedrockCrossRegionMode && (
											<span title="Cross-region inference mode">
												{bedrockCrossRegionMode}
											</span>
										)}
									</>
								)}
								{account.provider !== "bedrock" && account.customEndpoint && (
									<span
										className="inline-flex items-center gap-1 whitespace-nowrap"
										title={`Custom endpoint: ${account.customEndpoint}`}
									>
										<Globe className="h-3 w-3" />
										custom endpoint
									</span>
								)}
								{modelMappingCount > 0 && (
									<span className="inline-flex items-center gap-1 whitespace-nowrap">
										<Hash className="h-3 w-3" />
										{modelMappingCount} model{" "}
										{modelMappingCount === 1 ? "mapping" : "mappings"}
									</span>
								)}
							</div>

							{routingStates.length === 0 && (
								<p className="text-sm text-muted-foreground">
									No model-family routes reported for this account.
								</p>
							)}
							<div className="flex flex-wrap gap-2">
								<Button
									size="touch"
									variant="outline"
									onClick={() => onPriorityChange(account)}
								>
									Change priority…
								</Button>
								{onCustomEndpointChange && (
									<Button
										size="touch"
										variant="outline"
										onClick={() => onCustomEndpointChange(account)}
									>
										Custom endpoint…
									</Button>
								)}
								{onModelMappingsChange && (
									<Button
										size="touch"
										variant="outline"
										onClick={() => onModelMappingsChange(account)}
									>
										Model mappings…
									</Button>
								)}
							</div>
						</TabsContent>
						<TabsContent value="settings" className="space-y-4 py-3">
							{hasSettings && (
								<div className="grid gap-x-8 gap-y-3 sm:grid-cols-2 xl:grid-cols-3">
									{showAutoFeatures && (
										<div className={SETTING_CLASS}>
											<span className="text-sm font-medium">
												Return after reset
											</span>
											<Switch
												className={SETTING_SWITCH_CLASS}
												checked={account.autoFallbackEnabled}
												aria-label={`Return after reset for ${account.name}`}
												onCheckedChange={() => onAutoFallbackToggle(account)}
												title="Automatically switch back to this account from lower-priority ones when its rate limit resets. Requires multiple accounts with different priorities."
											/>
											<p className="basis-full text-xs text-muted-foreground">
												Switch back from lower-priority accounts when this
												account’s limit resets.
											</p>
										</div>
									)}
									{showPlanBilling && (
										<div className={SETTING_CLASS}>
											<span className="text-sm font-medium">Plan billing</span>
											<Switch
												className={SETTING_SWITCH_CLASS}
												checked={account.billingType === "plan"}
												aria-label={`Plan billing for ${account.name}`}
												onCheckedChange={() => onBillingTypeToggle(account)}
												title="Toggle plan billing for this account"
											/>
											<p className="basis-full text-xs text-muted-foreground">
												Classify this account as plan-billed rather than
												pay-as-you-go.
											</p>
										</div>
									)}
									{(showAutoPause || extraUsage) && (
										<div className={SETTING_CLASS}>
											{showAutoPause && onAutoPauseOnOverageToggle && (
												<>
													<span className="text-sm font-medium">
														Don’t use extra usage on this login
													</span>
													<Switch
														className={SETTING_SWITCH_CLASS}
														checked={account.autoPauseOnOverageEnabled ?? false}
														aria-label={`Don’t use extra usage on ${account.name}`}
														onCheckedChange={() =>
															onAutoPauseOnOverageToggle(account)
														}
														title="Keeps the router from sending this login a request that a spent plan limit covers, so Anthropic does not bill it as extra usage. A login paused for extra usage comes back when you resume it, or after its stored reset time only if Return after reset is on. Turning this switch off ends every hold at once."
													/>
												</>
											)}
											{extraUsage && <ExtraUsageDetails status={extraUsage} />}
											{showAutoPause && (
												<p className="basis-full text-xs text-muted-foreground">
													Best effort: Anthropic can bill a request before the
													router learns that a limit is spent. The router never
													changes your setting at Anthropic.
												</p>
											)}
										</div>
									)}
									{showCreditDrain && onCodexCreditDrainToggle && (
										<CodexCreditDrainControl
											account={account}
											onToggle={onCodexCreditDrainToggle}
										/>
									)}
									{onPublicValueToggle && (
										<PublicValueControl
											account={account}
											onToggle={onPublicValueToggle}
											onEditLabel={onPublicValueEditLabel}
										/>
									)}
									{showPeakHoursPause && onPeakHoursPauseToggle && (
										<div className={SETTING_CLASS}>
											<span className="text-sm font-medium">
												Pause during peak hours
											</span>
											<Switch
												className={SETTING_SWITCH_CLASS}
												checked={account.peakHoursPauseEnabled ?? false}
												aria-label={`Pause during peak hours for ${account.name}`}
												onCheckedChange={() => onPeakHoursPauseToggle(account)}
												title="Automatically pause this account during Zai peak hours (Monday–Friday, 14:00–18:00 SGT)"
											/>
											<p className="basis-full text-xs text-muted-foreground">
												Pause Monday–Friday from 14:00–18:00 Singapore time.
											</p>
										</div>
									)}
								</div>
							)}

							{!hasSettings && (
								<p className="text-sm text-muted-foreground">
									No additional settings for this provider.
								</p>
							)}
						</TabsContent>
					</Tabs>
				)}
			</section>
		</article>
	);
}
