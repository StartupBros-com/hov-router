import { StrategyName } from "@better-ccflare/core";
import type { RoutingAttemptSummaryResponse } from "@better-ccflare/types";
import {
	useModelCapacityRouting,
	useRoutingAttemptSummary,
	useSetModelCapacityRouting,
	useSetStrategy,
	useStrategy,
} from "../../hooks/queries";
import { useApiError } from "../../hooks/useApiError";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import { Label } from "../ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";
import { EmptyState, ErrorState, LoadingState } from "../ui/state";
import { StatusPill } from "../ui/status-pill";
import { Switch } from "../ui/switch";
import { getErrorMeta } from "./system-status/errorCodeMeta";

const STRATEGY_OPTIONS: ReadonlyArray<{ label: string; value: StrategyName }> =
	[
		{ label: "Session", value: StrategyName.Session },
		{ label: "Session affinity", value: StrategyName.SessionAffinity },
		{ label: "Least used", value: StrategyName.LeastUsed },
		{
			label: "Session — drain soonest",
			value: StrategyName.SessionDrainSoonest,
		},
		{
			label: "Session — drain soonest (strict)",
			value: StrategyName.SessionDrainSoonestStrict,
		},
	];

export interface StrategySelectItem {
	label: string;
	value: string;
	disabled?: boolean;
}

// Show an unknown server value without offering to save it.
export function getStrategySelectItems(
	strategy: string,
): readonly StrategySelectItem[] {
	const isListed = STRATEGY_OPTIONS.some((opt) => opt.value === strategy);
	if (isListed) {
		return STRATEGY_OPTIONS;
	}
	return [
		...STRATEGY_OPTIONS,
		{ label: `${strategy} (current)`, value: strategy, disabled: true },
	];
}

export type RoutingAttemptSummaryViewState =
	| { status: "loading" }
	| { status: "error"; message?: string }
	| { status: "success"; data: RoutingAttemptSummaryResponse };

export interface RoutingCardViewProps {
	strategy: string;
	onStrategyChange: (strategy: string) => void;
	strategyDisabled: boolean;
	strategySource: "env" | "file" | "default";
	capacityMode: "off" | "exhausted";
	capacitySource: "env" | "file" | "default";
	onCapacityChange: (mode: "off" | "exhausted") => void;
	capacityDisabled: boolean;
	routingAttempts?: RoutingAttemptSummaryViewState;
	/** When given, the attempts error state offers Retry. */
	onRetryRoutingAttempts?: () => void;
	/** Keeps Retry visible but disabled while a retry is fetching. */
	retryRoutingAttemptsDisabled?: boolean;
	/** True while the last strategy save has failed. */
	strategySaveFailed?: boolean;
	/** True while the last capacity-routing save has failed. */
	capacitySaveFailed?: boolean;
}

/**
 * Presentational routing settings card. Kept free of data hooks so it can be
 * rendered with plain props in tests (renderToStaticMarkup); RoutingCard wires
 * it to react-query.
 */
export function RoutingCardView({
	strategy,
	onStrategyChange,
	strategyDisabled,
	strategySource,
	capacityMode,
	capacitySource,
	onCapacityChange,
	capacityDisabled,
	routingAttempts = { status: "loading" },
	onRetryRoutingAttempts,
	retryRoutingAttemptsDisabled,
	strategySaveFailed,
	capacitySaveFailed,
}: RoutingCardViewProps) {
	const strategyEnvLocked = strategySource === "env";
	const capacityEnvLocked = capacitySource === "env";
	const strategyItems = getStrategySelectItems(strategy);

	return (
		<Card className="card-hover">
			<CardHeader>
				<CardTitle>Routing</CardTitle>
				<CardDescription>
					Choose how requests are spread across accounts and whether accounts
					that have exhausted a model's weekly capacity are skipped.
				</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="space-y-6">
					<div className="space-y-2">
						<div className="flex items-center gap-2">
							<Label htmlFor="routing-strategy">Load-balancing strategy</Label>
							{strategyEnvLocked && (
								<StatusPill
									tone="warning"
									title="Set by the LB_STRATEGY environment variable; change the env var to edit this."
								>
									env-locked
								</StatusPill>
							)}
						</div>
						<div className="text-sm text-muted-foreground">
							<span className="font-medium">Session</span> reuses one
							account-level session across clients.{" "}
							<span className="font-medium">Session — drain soonest</span> keeps
							its owner while affinity and routing policy allow; weekly-reset
							ranking orders fresh selection and failover.{" "}
							<span className="font-medium">
								Session — drain soonest (strict)
							</span>{" "}
							orders candidates within each authorized routing class by earliest
							future weekly reset; an active session only breaks ties, while
							explicit owner-retention and route-circuit decisions remain
							authoritative.
						</div>
						{strategyEnvLocked && (
							<p className="text-xs text-muted-foreground">
								Set by the LB_STRATEGY environment variable; change the env var
								to edit this.
							</p>
						)}
						<Select
							disabled={strategyDisabled || strategyEnvLocked}
							value={strategy}
							onValueChange={onStrategyChange}
						>
							<SelectTrigger id="routing-strategy" className="h-11 w-64">
								<SelectValue placeholder="Select strategy..." />
							</SelectTrigger>
							<SelectContent>
								{strategyItems.map((opt) => (
									<SelectItem
										className="min-h-11"
										key={opt.value}
										value={opt.value}
										disabled={opt.disabled}
									>
										{opt.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<div className="text-xs text-muted-foreground">
							Session affinity keeps a client on its eligible account for cache
							reuse. Least used considers utilization and recent picks on each
							request, spreading bursts but potentially losing cache hits.
						</div>
						{strategySaveFailed && (
							<p role="alert" className="text-xs text-destructive">
								Could not save the load-balancing strategy. The previous setting
								is still in effect.
							</p>
						)}
					</div>

					<div className="flex items-center justify-between gap-3">
						<div className="min-w-0 space-y-1">
							<div className="flex items-center gap-2">
								<Label
									htmlFor="routing-capacity"
									className="inline-flex min-h-11 items-center"
								>
									Model-scoped capacity routing
								</Label>
								{capacityEnvLocked && (
									<StatusPill
										tone="warning"
										title="Set by the MODEL_SCOPED_CAPACITY_ROUTING environment variable; change the env var to edit this."
									>
										env-locked
									</StatusPill>
								)}
							</div>
							<div className="break-words text-sm text-muted-foreground">
								Accounts with no capacity left for the requested model are
								skipped, and the remaining accounts still handle the request. If
								none are left, the request fails with a retryable 503
								(model_pool_exhausted) instead of retrying accounts that are
								certain to fail.
							</div>
							{capacityEnvLocked && (
								<p className="text-xs text-muted-foreground">
									Set by the MODEL_SCOPED_CAPACITY_ROUTING environment variable;
									change the env var to edit this.
								</p>
							)}
							{capacitySaveFailed && (
								<p role="alert" className="text-xs text-destructive">
									Could not save the model-scoped capacity routing setting. The
									previous setting is still in effect.
								</p>
							)}
						</div>
						<div className="flex shrink-0 items-center gap-3">
							<Switch
								id="routing-capacity"
								disabled={capacityDisabled || capacityEnvLocked}
								checked={capacityMode === "exhausted"}
								onCheckedChange={(checked) =>
									onCapacityChange(checked ? "exhausted" : "off")
								}
							/>
							<span className="text-sm text-muted-foreground">
								{capacityMode === "exhausted" ? "Enabled" : "Disabled"}
							</span>
						</div>
					</div>

					<section
						className="space-y-2 border-t pt-4"
						aria-labelledby="routing-attempt-summary-heading"
					>
						<div className="space-y-1">
							<h3
								id="routing-attempt-summary-heading"
								className="text-sm font-medium"
							>
								Routing attempts (last 24 hours)
							</h3>
							<p className="text-xs text-muted-foreground">
								These are upstream routing events, not terminal client failures.
								Telemetry is post-deployment only; historical routing attempts
								were not backfilled.
							</p>
						</div>
						{routingAttempts.status === "loading" && (
							<LoadingState
								size="inline"
								label="Loading routing-attempt summary"
							/>
						)}
						{routingAttempts.status === "error" && (
							<ErrorState
								size="inline"
								title="Routing-attempt summary could not load"
								message={routingAttempts.message}
								onRetry={onRetryRoutingAttempts}
								retryDisabled={retryRoutingAttemptsDisabled}
							/>
						)}
						{routingAttempts.status === "success" &&
							(routingAttempts.data.totalAttempts === 0 ? (
								<EmptyState
									size="inline"
									title="No upstream routing attempts in this window."
								/>
							) : (
								<div className="space-y-2 text-sm">
									<p className="tabular-nums">
										{routingAttempts.data.totalAttempts} attempts across{" "}
										{routingAttempts.data.distinctRequests} logical requests
									</p>
									<p className="text-muted-foreground">
										{routingAttempts.data.recoveredRequests} recovered;{" "}
										{routingAttempts.data.terminalFailureRequests} terminal
										failure; {routingAttempts.data.awaitingTerminalRequests}{" "}
										awaiting terminal
									</p>
									{routingAttempts.data.firstObservedAt && (
										<p className="text-muted-foreground">
											First observed{" "}
											<time dateTime={routingAttempts.data.firstObservedAt}>
												{new Date(
													routingAttempts.data.firstObservedAt,
												).toLocaleString()}
											</time>
										</p>
									)}
									<ul
										className="space-y-1"
										aria-label="Routing attempt reason and scope outcomes"
									>
										{routingAttempts.data.byReasonScope.map((row) => (
											<li key={`${row.reason}:${row.scope}`}>
												<span className="font-medium" title={row.reason}>
													{getErrorMeta(row.reason).title} · {row.scope}
												</span>{" "}
												{row.attemptCount} attempts; {row.recoveredRequests}{" "}
												recovered; {row.terminalFailureRequests} terminal
												failure; {row.awaitingTerminalRequests} awaiting
												terminal
											</li>
										))}
									</ul>
								</div>
							))}
					</section>
				</div>
			</CardContent>
		</Card>
	);
}

export function RoutingCard() {
	const { formatError } = useApiError();
	const { data: strategyData, isLoading: strategyLoading } = useStrategy();
	const setStrategy = useSetStrategy();
	const { data: capacity, isLoading: capacityLoading } =
		useModelCapacityRouting();
	const setCapacity = useSetModelCapacityRouting();
	const routingAttempts = useRoutingAttemptSummary("24h");
	const routingAttemptsView: RoutingAttemptSummaryViewState =
		routingAttempts.data !== undefined
			? { status: "success", data: routingAttempts.data }
			: routingAttempts.isError
				? { status: "error", message: formatError(routingAttempts.error) }
				: { status: "loading" };

	return (
		<RoutingCardView
			strategy={strategyData?.strategy ?? "session"}
			strategySource={strategyData?.strategySource ?? "default"}
			onStrategyChange={(value) => setStrategy.mutate(value)}
			strategyDisabled={strategyLoading || setStrategy.isPending}
			capacityMode={capacity?.mode ?? "off"}
			capacitySource={capacity?.source ?? "default"}
			onCapacityChange={(mode) => setCapacity.mutate(mode)}
			capacityDisabled={capacityLoading || setCapacity.isPending}
			routingAttempts={routingAttemptsView}
			onRetryRoutingAttempts={() => routingAttempts.refetch()}
			retryRoutingAttemptsDisabled={routingAttempts.isFetching}
			strategySaveFailed={setStrategy.isError}
			capacitySaveFailed={setCapacity.isError}
		/>
	);
}
