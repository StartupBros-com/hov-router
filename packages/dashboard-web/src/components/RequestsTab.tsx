import {
	formatDuration,
	formatTokens,
	formatTokensPerSecond,
} from "@better-ccflare/ui-common";
import {
	AlertCircle,
	Bot,
	ChevronDown,
	ChevronRight,
	Clock,
	Eye,
	Filter,
	Hash,
	Key,
	RefreshCw,
	User,
	X,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { api, type RequestPayload, type RequestSummary } from "../api";
import { API_LIMITS } from "../constants";
import { useAccounts, useApiKeys, useRequests } from "../hooks/queries";
import { useApiError } from "../hooks/useApiError";
import { useRequestStream } from "../hooks/useRequestStream";
import {
	attributionSourceLabel,
	describeRequestAgent,
	groupAgentFilterOptions,
} from "../lib/attribution";
import { activeRequestFilters } from "../lib/request-filters";
import { requestModelLabel } from "../lib/request-model-label";
import { httpStatusTone } from "../lib/request-status";
import { isAnthropicPeakHour, isZaiPeakHour } from "../utils/provider-utils";
import { CopyButton } from "./CopyButton";
import { RoutePageHeader } from "./page-shell";
import { RequestAgentBadge } from "./RequestAgentBadge";
import { RequestCostBadge } from "./RequestCostBadge";
import { RequestDetailsModal } from "./RequestDetailsModal";
import { ActiveFilterBar } from "./requests/ActiveFilterBar";
import { RequestStatusPill } from "./requests/RequestStatusPill";
import { TokenUsageDisplay } from "./TokenUsageDisplay";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "./ui/card";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { EventTime } from "./ui/event-time";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "./ui/select";
import { EmptyState, ErrorState, LoadingState } from "./ui/state";
import { StatusPill } from "./ui/status-pill";

export function RequestsTab() {
	const [expandedRequests, setExpandedRequests] = useState<Set<string>>(
		new Set(),
	);
	const [modalRequest, setModalRequest] = useState<RequestPayload | null>(null);
	const modalSnapshotRef = useRef<{
		id: string;
		request: RequestPayload;
		summary: RequestSummary | undefined;
	} | null>(null);
	const [accountFilter, setAccountFilter] = useState<string>("all");
	const [agentFilter, setAgentFilter] = useState<string>("all");
	const [apiKeyFilter, setApiKeyFilter] = useState<string>("all");
	const [dateFrom, setDateFrom] = useState<string>("");
	const [dateTo, setDateTo] = useState<string>("");
	const [showFilters, setShowFilters] = useState(false);
	const [statusCodeFilters, setStatusCodeFilters] = useState<Set<string>>(
		new Set(),
	);

	const {
		data: requestsData,
		isError: requestsError,
		error,
		refetch: loadRequests,
	} = useRequests(API_LIMITS.requestsDetail);

	// Enable real-time updates
	useRequestStream(API_LIMITS.requestsDetail);

	const { data: accounts } = useAccounts();
	const { data: configuredApiKeys } = useApiKeys();
	const zaiAccountNames = new Set(
		(accounts ?? []).filter((a) => a.provider === "zai").map((a) => a.name),
	);
	const oauthAccountNames = new Set(
		(accounts ?? [])
			.filter((a) => a.provider === "anthropic")
			.map((a) => a.name),
	);

	// Transform the data to match the expected structure - memoized to avoid recalculation on SSE updates
	const data = useMemo(() => {
		if (!requestsData) return null;
		return {
			requests: requestsData.requests,
			summaries:
				requestsData.detailsMap instanceof Map
					? (requestsData.detailsMap as Map<string, RequestSummary>)
					: new Map<string, RequestSummary>(
							Array.isArray(requestsData.detailsMap)
								? (requestsData.detailsMap as RequestSummary[]).map(
										(s) => [s.id, s] as [string, RequestSummary],
									)
								: [],
						),
		};
	}, [requestsData]);

	// Retain only the open modal's last live payload and summary after SSE eviction.
	const retainedModal =
		modalSnapshotRef.current?.id === modalRequest?.id
			? modalSnapshotRef.current
			: null;
	const liveModalRequest = modalRequest
		? data?.requests.find((request) => request.id === modalRequest.id)
		: undefined;
	const modalPayload =
		liveModalRequest ?? retainedModal?.request ?? modalRequest;
	const modalSummary =
		(modalRequest ? data?.summaries.get(modalRequest.id) : undefined) ??
		retainedModal?.summary;
	modalSnapshotRef.current =
		modalRequest && modalPayload
			? { id: modalRequest.id, request: modalPayload, summary: modalSummary }
			: null;

	// Filter dropdown options come from dedicated endpoints (not from the loaded
	// requests slice) so every configured account/API key is selectable, even
	// when it doesn't appear in the most recent N requests.
	const uniqueAccounts = useMemo(() => {
		const fromConfig = (accounts ?? []).map((a) => a.name).filter(Boolean);
		const fromRequests = (data?.requests ?? [])
			.map((r) => r.meta.accountName || r.meta.accountId)
			.filter((v): v is string => Boolean(v));
		return Array.from(new Set([...fromConfig, ...fromRequests])).sort();
	}, [accounts, data]);

	// Extract unique status codes for filter - memoized
	const uniqueStatusCodes = useMemo(() => {
		if (!data) return [];
		return Array.from(
			new Set(
				data.requests
					.map((r) => r.response?.status)
					.filter((status): status is number => status !== undefined),
			),
		).sort((a, b) => a - b);
	}, [data]);

	// Agent filter options, with session-id fallbacks listed apart from agents
	const agentFilterOptions = useMemo(() => {
		if (!data) return { agents: [], sessions: [] };
		return groupAgentFilterOptions(
			data.requests.map((r) => {
				const summary = data.summaries.get(r.id);
				return {
					agentUsed: summary?.agentUsed || r.meta.agentUsed,
					source:
						summary?.agentAttributionSource || r.meta.agentAttributionSource,
				};
			}),
		);
	}, [data]);
	const agentFilterSession = agentFilterOptions.sessions.find(
		(s) => s.value === agentFilter,
	);

	// API key filter: union of all configured keys (from /api/api-keys) and any
	// keys observed in the loaded request slice (covers historical keys that
	// were deleted but still appear on past requests).
	const uniqueApiKeys = useMemo(() => {
		const fromConfig = (configuredApiKeys ?? []).map((k) => k.name);
		const fromRequests = data
			? Array.from(data.summaries.values())
					.map((s) => s.apiKeyName)
					.filter((v): v is string => Boolean(v))
			: [];
		return Array.from(new Set([...fromConfig, ...fromRequests])).sort();
	}, [configuredApiKeys, data]);

	// Filter requests based on selected filters - memoized to avoid recalculation on every render
	const filteredRequests = useMemo(() => {
		if (!data) return [];
		return data.requests.filter((request) => {
			// Account filter
			if (accountFilter !== "all") {
				const requestAccount =
					request.meta.accountName || request.meta.accountId;
				if (requestAccount !== accountFilter) return false;
			}

			// Agent filter
			if (agentFilter !== "all") {
				const summary = data.summaries.get(request.id);
				const requestAgent = summary?.agentUsed || request.meta.agentUsed;
				if (requestAgent !== agentFilter) return false;
			}

			// API key filter
			if (apiKeyFilter !== "all") {
				const summary = data.summaries.get(request.id);
				const requestApiKey = summary?.apiKeyName;
				if (apiKeyFilter === "no-api-key") {
					if (requestApiKey) return false;
				} else {
					if (requestApiKey !== apiKeyFilter) return false;
				}
			}

			// Status code filter
			if (statusCodeFilters.size > 0 && request.response?.status) {
				if (!statusCodeFilters.has(request.response.status.toString())) {
					return false;
				}
			}

			// Date range filter
			const requestDate = new Date(request.meta.timestamp);
			if (dateFrom) {
				const fromDate = new Date(dateFrom);
				fromDate.setHours(0, 0, 0, 0);
				if (requestDate < fromDate) return false;
			}
			if (dateTo) {
				const toDate = new Date(dateTo);
				toDate.setHours(23, 59, 59, 999);
				if (requestDate > toDate) return false;
			}

			return true;
		});
	}, [
		data,
		accountFilter,
		agentFilter,
		apiKeyFilter,
		statusCodeFilters,
		dateFrom,
		dateTo,
	]);

	const toggleExpanded = (id: string) => {
		setExpandedRequests((prev) => {
			const next = new Set(prev);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});
	};

	// Date preset helpers
	const applyDatePreset = (preset: string) => {
		const now = new Date();
		const toDate = now.toISOString().slice(0, 16);

		switch (preset) {
			case "1h": {
				const fromDate = new Date(now.getTime() - 60 * 60 * 1000);
				setDateFrom(fromDate.toISOString().slice(0, 16));
				setDateTo(toDate);
				break;
			}
			case "24h": {
				const fromDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
				setDateFrom(fromDate.toISOString().slice(0, 16));
				setDateTo(toDate);
				break;
			}
			case "7d": {
				const fromDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
				setDateFrom(fromDate.toISOString().slice(0, 16));
				setDateTo(toDate);
				break;
			}
			case "30d": {
				const fromDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
				setDateFrom(fromDate.toISOString().slice(0, 16));
				setDateTo(toDate);
				break;
			}
		}
	};

	const toggleStatusCode = (code: string) => {
		setStatusCodeFilters((prev) => {
			const next = new Set(prev);
			if (next.has(code)) {
				next.delete(code);
			} else {
				next.add(code);
			}
			return next;
		});
	};

	const clearAllFilters = () => {
		setAccountFilter("all");
		setAgentFilter("all");
		setApiKeyFilter("all");
		setDateFrom("");
		setDateTo("");
		setStatusCodeFilters(new Set());
	};

	const activeFilters = activeRequestFilters({
		account: accountFilter,
		agent: agentFilter,
		agentLabel: agentFilterSession?.label,
		apiKey: apiKeyFilter,
		statusCodes: statusCodeFilters,
		dateFrom,
		dateTo,
	});
	const hasActiveFilters = activeFilters.length > 0;
	const removeFilter = (key: (typeof activeFilters)[number]["key"]) => {
		if (key === "account") setAccountFilter("all");
		else if (key === "agent") setAgentFilter("all");
		else if (key === "apiKey") setApiKeyFilter("all");
		else if (key === "status") setStatusCodeFilters(new Set());
		else {
			setDateFrom("");
			setDateTo("");
		}
	};

	const decodeBase64 = (str: string | null): string => {
		if (!str) return "No data";
		try {
			// Handle edge cases like "[streamed]" from older data
			if (str === "[streamed]") {
				return "[Streaming data not captured]";
			}
			return atob(str);
		} catch (error) {
			console.error("Failed to decode base64:", error, "Input:", str);
			return `Failed to decode: ${str}`;
		}
	};

	/**
	 * Copy the given request to the clipboard as pretty-printed JSON, with
	 * any base64-encoded bodies already decoded for easier debugging.
	 */
	// copyRequest helper removed – handled inline by CopyButton

	return (
		<div className="space-y-4">
			<RoutePageHeader page="requests" />
			<Card>
				<CardHeader>
					<div className="flex flex-wrap items-center justify-between gap-2">
						<div>
							<CardTitle>Request History</CardTitle>
							<CardDescription>
								Detailed request and response data (last{" "}
								{API_LIMITS.requestsDetail})
							</CardDescription>
						</div>
						<div className="flex gap-2">
							<Button
								type="button"
								onClick={() => setShowFilters(!showFilters)}
								variant={showFilters ? "default" : "outline"}
								size="touch-sm"
								className="relative"
								aria-expanded={showFilters}
							>
								<Filter aria-hidden="true" />
								Filters
								{hasActiveFilters && !showFilters && (
									<>
										<span
											aria-hidden="true"
											className="absolute -top-1 -right-1 h-2 w-2 rounded-full bg-primary animate-pulse motion-reduce:animate-none"
										/>
										<span className="sr-only"> (filters active)</span>
									</>
								)}
							</Button>
							<Button
								type="button"
								onClick={() => loadRequests()}
								variant="ghost"
								size="touch-icon"
								aria-label="Refresh requests"
							>
								<RefreshCw aria-hidden="true" />
							</Button>
						</div>
					</div>
				</CardHeader>
				<CardContent>
					<ActiveFilterBar
						filters={activeFilters}
						shown={filteredRequests.length}
						total={data?.requests.length || 0}
						onRemove={removeFilter}
						onClearAll={clearAllFilters}
					/>

					{/* Filters Panel */}
					{showFilters && (
						<div className="mb-6 border rounded-lg bg-card">
							<div className="p-4 border-b">
								<div className="flex items-center justify-between">
									<h3 className="font-medium">Filters</h3>
									<Button
										type="button"
										variant="ghost"
										size="touch-icon"
										onClick={() => setShowFilters(false)}
										aria-label="Close filters"
									>
										<X aria-hidden="true" />
									</Button>
								</div>
							</div>

							<div className="p-4 space-y-4">
								{/* Time Range Section */}
								<div>
									<h4 className="text-sm font-medium mb-3 flex items-center gap-2">
										<Clock className="h-4 w-4" aria-hidden="true" />
										Time Range
									</h4>
									<div className="flex flex-wrap gap-2 mb-3">
										<Button
											variant={dateFrom || dateTo ? "outline" : "secondary"}
											size="touch-sm"
											onClick={() => applyDatePreset("1h")}
										>
											Last hour
										</Button>
										<Button
											variant={dateFrom || dateTo ? "outline" : "secondary"}
											size="touch-sm"
											onClick={() => applyDatePreset("24h")}
										>
											Last 24h
										</Button>
										<Button
											variant={dateFrom || dateTo ? "outline" : "secondary"}
											size="touch-sm"
											onClick={() => applyDatePreset("7d")}
										>
											Last 7 days
										</Button>
										<Button
											variant={dateFrom || dateTo ? "outline" : "secondary"}
											size="touch-sm"
											onClick={() => applyDatePreset("30d")}
										>
											Last 30 days
										</Button>
									</div>
									<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
										<div>
											<Label htmlFor="date-from" className="text-xs">
												From
											</Label>
											<Input
												id="date-from"
												type="datetime-local"
												value={dateFrom}
												onChange={(e) => setDateFrom(e.target.value)}
												className="h-11 text-sm"
											/>
										</div>
										<div>
											<Label htmlFor="date-to" className="text-xs">
												To
											</Label>
											<Input
												id="date-to"
												type="datetime-local"
												value={dateTo}
												onChange={(e) => setDateTo(e.target.value)}
												className="h-11 text-sm"
											/>
										</div>
									</div>
								</div>

								<div className="h-px bg-border" />

								{/* Resource Filters */}
								<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
									{/* Account Filter */}
									<div>
										<Label
											htmlFor="filter-account"
											className="text-xs flex items-center gap-1 mb-2"
										>
											<User className="h-3 w-3" aria-hidden="true" />
											Account
										</Label>
										<Select
											value={accountFilter}
											onValueChange={setAccountFilter}
										>
											<SelectTrigger id="filter-account" className="h-11">
												<SelectValue placeholder="All accounts" />
											</SelectTrigger>
											<SelectContent>
												<SelectItem value="all">All accounts</SelectItem>
												{uniqueAccounts.map((account) => (
													<SelectItem key={account} value={account || ""}>
														{account}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									</div>

									{/* Agent Filter */}
									<div>
										<Label
											htmlFor="filter-agent"
											className="text-xs flex items-center gap-1 mb-2"
										>
											<Bot className="h-3 w-3" aria-hidden="true" />
											Agent
										</Label>
										<Select value={agentFilter} onValueChange={setAgentFilter}>
											<SelectTrigger id="filter-agent" className="h-11">
												<SelectValue placeholder="All agents" />
											</SelectTrigger>
											<SelectContent>
												<SelectItem value="all">All agents</SelectItem>
												{agentFilterOptions.agents.length > 0 && (
													<SelectGroup>
														<SelectLabel>Agents</SelectLabel>
														{agentFilterOptions.agents.map((agent) => (
															<SelectItem key={agent} value={agent}>
																{agent}
															</SelectItem>
														))}
													</SelectGroup>
												)}
												{agentFilterOptions.sessions.length > 0 && (
													<SelectGroup>
														<SelectLabel>
															No agent detected (by session)
														</SelectLabel>
														{agentFilterOptions.sessions.map((session) => (
															<SelectItem
																key={session.value}
																value={session.value}
																title={`Claude Code session ${session.value}`}
															>
																{session.label}
															</SelectItem>
														))}
													</SelectGroup>
												)}
											</SelectContent>
										</Select>
									</div>

									{/* API Key Filter */}
									<div>
										<Label
											htmlFor="filter-api-key"
											className="text-xs flex items-center gap-1 mb-2"
										>
											<Key className="h-3 w-3" aria-hidden="true" />
											API Key
										</Label>
										<Select
											value={apiKeyFilter}
											onValueChange={setApiKeyFilter}
										>
											<SelectTrigger id="filter-api-key" className="h-11">
												<SelectValue placeholder="All API keys" />
											</SelectTrigger>
											<SelectContent>
												<SelectItem value="all">All API keys</SelectItem>
												<SelectItem value="no-api-key">No API Key</SelectItem>
												{uniqueApiKeys.map((key) => (
													<SelectItem key={key} value={key || ""}>
														{key}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									</div>

									{/* Status Code Filter */}
									<div>
										<Label
											htmlFor="filter-status"
											className="text-xs flex items-center gap-1 mb-2"
										>
											<Hash className="h-3 w-3" aria-hidden="true" />
											Status Code
										</Label>
										<DropdownMenu>
											<DropdownMenuTrigger asChild>
												<Button
													id="filter-status"
													type="button"
													variant="outline"
													className="h-11 w-full justify-between font-normal"
												>
													{statusCodeFilters.size > 0
														? `${statusCodeFilters.size} selected`
														: "All codes"}
													<ChevronDown
														className="opacity-50"
														aria-hidden="true"
													/>
												</Button>
											</DropdownMenuTrigger>
											<DropdownMenuContent className="w-56 max-h-64 overflow-y-auto">
												<DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
													Select status codes
												</DropdownMenuLabel>
												{uniqueStatusCodes.map((code) => (
													<DropdownMenuCheckboxItem
														key={code}
														className="min-h-11"
														checked={statusCodeFilters.has(code.toString())}
														onCheckedChange={() =>
															toggleStatusCode(code.toString())
														}
														onSelect={(event) => event.preventDefault()}
													>
														<StatusPill
															tone={httpStatusTone(code)}
															className="tabular-nums"
														>
															{code}
														</StatusPill>
													</DropdownMenuCheckboxItem>
												))}
											</DropdownMenuContent>
										</DropdownMenu>
									</div>
								</div>
							</div>
						</div>
					)}

					{requestsData === undefined ? (
						requestsError ? (
							<RequestsLoadError
								error={error}
								onRetry={() => void loadRequests()}
							/>
						) : (
							<LoadingState label="Loading requests" />
						)
					) : data?.requests.length === 0 ? (
						<EmptyState title="No requests found" />
					) : filteredRequests.length === 0 ? (
						<EmptyState title="No requests match the selected filters" />
					) : (
						<div className="space-y-2">
							{filteredRequests.map((request) => {
								const isExpanded = expandedRequests.has(request.id);
								const isError =
									!request.meta.pending &&
									Boolean(request.error || !request.meta.success);
								const statusCode = request.response?.status;
								const summary = data?.summaries.get(request.id);
								const modelLabel = requestModelLabel(summary);
								const method = request.meta.method || summary?.method;
								const path = request.meta.path || summary?.path;
								const accountLabel =
									request.meta.accountName ||
									(request.meta.accountId
										? `${request.meta.accountId.slice(0, 8)}...`
										: null);
								const agentView = describeRequestAgent(
									summary?.agentUsed || request.meta.agentUsed,
									summary?.agentAttributionSource ||
										request.meta.agentAttributionSource,
								);
								const projectSrcLabel = attributionSourceLabel(
									summary?.projectAttributionSource,
								);
								const isZaiPeak =
									zaiAccountNames.has(request.meta.accountName ?? "") &&
									isZaiPeakHour(request.meta.timestamp);
								const isAnthropicPeak =
									oauthAccountNames.has(request.meta.accountName ?? "") &&
									isAnthropicPeakHour(request.meta.timestamp);

								return (
									<div
										key={request.id}
										data-request-id={request.id}
										className={`border rounded-lg transition-all duration-300 ${
											isError ? "border-destructive/50" : "border-border"
										} ${request.meta.pending ? "animate-pulse motion-reduce:animate-none opacity-70" : "opacity-100"}`}
									>
										{/* Header row: one line from sm up; below sm the path takes its own line */}
										<div className="flex items-center gap-2 p-3">
											<button
												type="button"
												className="flex min-h-11 min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-left cursor-pointer sm:flex-nowrap"
												onClick={() => toggleExpanded(request.id)}
												aria-expanded={isExpanded}
											>
												{isExpanded ? (
													<ChevronDown
														className="h-4 w-4 shrink-0 text-muted-foreground"
														aria-hidden="true"
													/>
												) : (
													<ChevronRight
														className="h-4 w-4 shrink-0 text-muted-foreground"
														aria-hidden="true"
													/>
												)}
												<EventTime
													value={request.meta.timestamp}
													className="text-xs font-mono tabular-nums text-muted-foreground shrink-0 whitespace-nowrap"
												/>
												<RequestStatusPill
													statusCode={statusCode}
													pending={Boolean(request.meta.pending)}
													isError={isError}
													className="shrink-0"
												/>
												{method && (
													<span className="text-xs font-semibold uppercase shrink-0">
														{method}
													</span>
												)}
												{path && (
													<span className="order-last basis-full truncate pl-6 text-xs font-mono text-muted-foreground min-w-0 sm:order-none sm:basis-auto sm:flex-1 sm:pl-0">
														{path}
													</span>
												)}
												{summary?.responseTimeMs != null && (
													<span
														className="text-xs font-mono tabular-nums text-muted-foreground shrink-0"
														title="Response time"
													>
														{formatDuration(summary.responseTimeMs)}
													</span>
												)}
												<span
													className="text-[11px] font-mono text-muted-foreground/70 shrink-0 hidden sm:inline"
													title={request.id}
												>
													{request.id.slice(0, 8)}
												</span>
											</button>

											{/* Action buttons stay outside the toggle-expand button so they
										    never get cut off by flex shrinking and have their own hit area. */}
											<div className="flex items-center gap-1 shrink-0">
												<Button
													variant="ghost"
													size="touch-icon"
													onClick={() => setModalRequest(request)}
													title="View Details"
													aria-label="View request details"
												>
													<Eye aria-hidden="true" />
												</Button>
												<CopyButton
													variant="ghost"
													size="touch-icon"
													title="Copy as JSON"
													label="Copy request as JSON"
													getValueAsync={async () => {
														const full = request.meta.bodiesOmitted
															? await api.getRequestPayload(request.id)
															: request;
														const decoded: RequestPayload & {
															decoded?: true;
														} = {
															...full,
															request: full.request
																? {
																		...full.request,
																		body: full.request.body
																			? decodeBase64(full.request.body)
																			: null,
																	}
																: full.request,
															response: full.response
																? {
																		...full.response,
																		body: full.response.body
																			? decodeBase64(full.response.body)
																			: null,
																	}
																: null,
															decoded: true,
														};
														return JSON.stringify(decoded, null, 2);
													}}
												/>
											</div>
										</div>

										{/* Badges row: wraps freely, holds all the non-essential context */}
										{(modelLabel ||
											summary?.project ||
											agentView ||
											summary?.comboName ||
											summary?.apiKeyName ||
											summary?.totalTokens != null ||
											(summary != null && !request.meta.pending) ||
											summary?.billingType ||
											(summary?.tokensPerSecond ?? 0) > 0 ||
											accountLabel ||
											request.meta.rateLimited ||
											isZaiPeak ||
											isAnthropicPeak) && (
											<div className="flex flex-wrap items-center gap-1.5 px-3 pb-2 pl-9 text-xs">
												{modelLabel?.kind === "response" && (
													<Badge variant="secondary" className="text-xs">
														{modelLabel.model}
													</Badge>
												)}
												{modelLabel && modelLabel.kind !== "response" && (
													<Badge
														variant="outline"
														className="text-xs"
														title="No response model: this is the model the request asked for"
													>
														{modelLabel.kind === "requested"
															? "Requested: "
															: "Routed: "}
														{modelLabel.model}
														{modelLabel.routedTo && ` → ${modelLabel.routedTo}`}
													</Badge>
												)}
												{summary?.project && (
													<Badge variant="secondary" className="text-xs">
														Project: {summary.project}
														{projectSrcLabel && (
															<span className="text-muted-foreground/70 ml-1">
																· {projectSrcLabel}
															</span>
														)}
													</Badge>
												)}
												<RequestAgentBadge
													view={agentView}
													className="text-xs"
												/>
												{summary?.comboName && (
													<Badge variant="outline" className="text-xs">
														Combo: {summary.comboName}
													</Badge>
												)}
												{summary?.apiKeyName && (
													<Badge variant="outline" className="text-xs">
														<Key className="h-3 w-3 mr-1" />
														{summary.apiKeyName}
													</Badge>
												)}
												{summary?.totalTokens != null && (
													<Badge variant="outline" className="text-xs">
														{formatTokens(summary.totalTokens)} tokens
													</Badge>
												)}
												<RequestCostBadge
													summary={summary}
													pending={request.meta.pending}
													className="text-xs"
												/>
												{summary?.billingType === "overage" && (
													<StatusPill tone="warning">Overage</StatusPill>
												)}
												{summary?.billingType === "plan" && (
													<StatusPill tone="neutral">Plan</StatusPill>
												)}
												{summary?.tokensPerSecond != null &&
													summary.tokensPerSecond > 0 && (
														<Badge variant="secondary" className="text-xs">
															{formatTokensPerSecond(summary.tokensPerSecond)}
														</Badge>
													)}
												{accountLabel && (
													<span className="text-xs text-muted-foreground">
														via {accountLabel}
													</span>
												)}
												{request.meta.rateLimited && (
													<StatusPill tone="warning">Rate limited</StatusPill>
												)}
												{(isZaiPeak || isAnthropicPeak) && (
													<StatusPill
														tone="info"
														title={
															isZaiPeak
																? "Sent during Z.ai peak hours (Mon–Fri 14:00–18:00 Singapore time)"
																: "Sent during Anthropic peak hours (Mon–Fri 5–11 am Pacific)"
														}
													>
														Peak
													</StatusPill>
												)}
											</div>
										)}

										{request.error && (
											<div
												className="flex items-start gap-1.5 px-3 pb-2 pl-9 text-xs text-destructive"
												title={request.error}
											>
												<AlertCircle
													className="mt-0.5 h-3.5 w-3.5 shrink-0"
													aria-hidden="true"
												/>
												<p className="line-clamp-2 min-w-0 break-words">
													<span className="sr-only">Error: </span>
													{request.error}
												</p>
											</div>
										)}

										{isExpanded && (
											<div className="px-3 pb-3 pl-9 space-y-3">
												<TokenUsageDisplay
													summary={summary}
													pending={request.meta.pending}
												/>
												<Button
													variant="outline"
													size="touch-sm"
													onClick={() => setModalRequest(request)}
													className="w-full"
												>
													<Eye aria-hidden="true" />
													View More Details
												</Button>
											</div>
										)}
									</div>
								);
							})}
						</div>
					)}
				</CardContent>

				{modalRequest && (
					<RequestDetailsModal
						request={modalPayload ?? modalRequest}
						summary={modalSummary}
						isOpen={true}
						onClose={() => {
							modalSnapshotRef.current = null;
							setModalRequest(null);
						}}
					/>
				)}
			</Card>
		</div>
	);
}

function RequestsLoadError({
	error,
	onRetry,
}: {
	error: unknown;
	onRetry: () => void;
}) {
	const { formatError } = useApiError();
	return (
		<ErrorState
			title="Requests could not load"
			message={formatError(error)}
			onRetry={onRetry}
		/>
	);
}
