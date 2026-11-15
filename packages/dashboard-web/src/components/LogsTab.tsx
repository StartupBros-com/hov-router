import { Pause, Play, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type LogEntry } from "../api";
import { useLogHistory } from "../hooks/queries";
import { useApiError } from "../hooks/useApiError";
import { logLevelLabel, logLevelTone } from "../lib/log-level";
import type { StatusTone } from "../lib/request-status";
import { cn } from "../lib/utils";
import { RoutePageHeader } from "./page-shell";
import { Button } from "./ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "./ui/card";
import { EventTime } from "./ui/event-time";
import { EmptyState, ErrorState, LoadingState } from "./ui/state";
import { StatusPill } from "./ui/status-pill";

/** Text colour for each level tone; a pill per line would crowd 1,000 lines. */
const LEVEL_TEXT: Record<StatusTone, string> = {
	danger: "text-(--danger)",
	warning: "text-(--warning)",
	info: "text-(--info)",
	success: "text-(--success)",
	neutral: "text-muted-foreground",
};

export function LogsTab() {
	const [liveLogs, setLogs] = useState<LogEntry[] | null>(null);
	const [paused, setPaused] = useState(false);
	const [autoScroll, setAutoScroll] = useState(true);
	const eventSourceRef = useRef<EventSource | null>(null);
	const logsEndRef = useRef<HTMLDivElement>(null);
	const scrollTimeoutRef = useRef<NodeJS.Timeout | null>(null);
	// Guards against a stale streamLogs() resolving (the token-mint request
	// completes) after the stream was already stopped/torn down, or after a
	// newer startStreaming() call has superseded it — e.g. rapid
	// pause/resume, unmount while the mint request is in flight, or an
	// error-triggered reconnect racing a manual restart. Each startStreaming()
	// call captures the current generation; only the call whose generation is
	// still current when its promise resolves is allowed to touch the refs.
	const streamingRef = useRef(false);
	const generationRef = useRef(0);
	const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

	// The stream-token path (#379) is single-use: once EventSource connects,
	// the token is consumed server-side. If the connection drops, the
	// browser's native reconnect would replay the same (now-dead) token and
	// get stuck 401'ing forever. So on error we close the source ourselves
	// and re-run startStreaming(), which mints a fresh token, instead of
	// letting EventSource retry on its own.
	const startStreamingRef = useRef<() => void>(() => {});

	const startStreaming = useCallback(() => {
		streamingRef.current = true;
		const generation = ++generationRef.current;
		if (reconnectTimeoutRef.current) {
			clearTimeout(reconnectTimeoutRef.current);
			reconnectTimeoutRef.current = null;
		}
		const isCurrent = () =>
			streamingRef.current && generationRef.current === generation;
		api
			.streamLogs((log: LogEntry) => {
				setLogs((prev) => [...(prev ?? []).slice(-999), log]); // Keep last 1000 logs
				// Auto-scroll to bottom when new log arrives
				if (autoScroll && logsEndRef.current) {
					// Clear any pending scroll timeout to prevent accumulation
					if (scrollTimeoutRef.current) {
						clearTimeout(scrollTimeoutRef.current);
					}
					scrollTimeoutRef.current = setTimeout(() => {
						logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
						scrollTimeoutRef.current = null;
					}, 0);
				}
			})
			.then((eventSource) => {
				if (!isCurrent()) {
					eventSource.close();
					return;
				}
				eventSourceRef.current = eventSource;
				eventSource.onerror = () => {
					eventSource.close();
					if (eventSourceRef.current === eventSource) {
						eventSourceRef.current = null;
					}
					if (!isCurrent()) return;
					// Debounce so a persistently-down server doesn't spin us
					// into a tight mint-connect-fail loop.
					reconnectTimeoutRef.current = setTimeout(() => {
						reconnectTimeoutRef.current = null;
						if (isCurrent()) startStreamingRef.current();
					}, 2000);
				};
			})
			.catch((error) => {
				console.error("Failed to start log stream:", error);
				if (!isCurrent()) return;
				reconnectTimeoutRef.current = setTimeout(() => {
					reconnectTimeoutRef.current = null;
					if (isCurrent()) startStreamingRef.current();
				}, 2000);
			});
	}, [autoScroll]);

	startStreamingRef.current = startStreaming;

	const stopStreaming = useCallback(() => {
		streamingRef.current = false;
		generationRef.current++;
		if (reconnectTimeoutRef.current) {
			clearTimeout(reconnectTimeoutRef.current);
			reconnectTimeoutRef.current = null;
		}
		if (eventSourceRef.current) {
			eventSourceRef.current.onerror = null;
			eventSourceRef.current.close();
			eventSourceRef.current = null;
		}
		// Clear any pending scroll timeout
		if (scrollTimeoutRef.current) {
			clearTimeout(scrollTimeoutRef.current);
			scrollTimeoutRef.current = null;
		}
	}, []);

	// Load historical logs on mount
	const {
		data: history,
		isLoading: loading,
		error,
		isError,
		refetch,
	} = useLogHistory();
	const { formatError } = useApiError();
	const logs = liveLogs ?? history ?? [];

	useEffect(() => {
		if (history) {
			setLogs(history);
			// Auto-scroll to bottom after loading history
			if (autoScroll && logsEndRef.current) {
				// Clear any pending scroll timeout
				if (scrollTimeoutRef.current) {
					clearTimeout(scrollTimeoutRef.current);
				}
				scrollTimeoutRef.current = setTimeout(() => {
					logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
					scrollTimeoutRef.current = null;
				}, 0);
			}
		}
	}, [history, autoScroll]);

	useEffect(() => {
		if (!paused && !loading) {
			startStreaming();
		}

		return () => {
			stopStreaming();
			// Ensure scroll timeout is cleared on unmount
			if (scrollTimeoutRef.current) {
				clearTimeout(scrollTimeoutRef.current);
				scrollTimeoutRef.current = null;
			}
		};
	}, [paused, loading, startStreaming, stopStreaming]);

	useEffect(() => {
		if (autoScroll && logsEndRef.current) {
			logsEndRef.current.scrollIntoView({ behavior: "smooth" });
		}
	}, [autoScroll]);

	const clearLogs = () => {
		setLogs([]);
	};

	const togglePause = () => {
		setPaused(!paused);
	};

	return (
		<div className="space-y-4">
			<RoutePageHeader page="logs" />
			<Card>
				<CardHeader>
					<div className="flex flex-wrap items-center justify-between gap-2">
						<div>
							<CardTitle className="flex items-center gap-2">
								Live Logs
								{paused && <StatusPill tone="warning">Paused</StatusPill>}
							</CardTitle>
							<CardDescription>Real-time log stream</CardDescription>
						</div>
						<div className="flex gap-2">
							<Button onClick={togglePause} variant="outline" size="touch-sm">
								{paused ? (
									<>
										<Play aria-hidden="true" />
										Resume
									</>
								) : (
									<>
										<Pause aria-hidden="true" />
										Pause
									</>
								)}
							</Button>
							<Button onClick={clearLogs} variant="outline" size="touch-sm">
								<Trash2 aria-hidden="true" />
								Clear
							</Button>
						</div>
					</div>
				</CardHeader>
				<CardContent>
					<section
						aria-label="Log lines"
						// biome-ignore lint/a11y/noNoninteractiveTabindex: the lines hold nothing focusable, so without a tab stop a keyboard user cannot scroll them (WCAG 2.1.1, axe scrollable-region-focusable)
						tabIndex={0}
						className="space-y-1 max-h-[500px] overflow-y-auto rounded-md text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						{history === undefined ? (
							isError ? (
								<ErrorState
									size="inline"
									title="Logs could not load"
									message={formatError(error)}
									onRetry={() => void refetch()}
								/>
							) : (
								<LoadingState size="inline" label="Loading logs" />
							)
						) : logs.length === 0 ? (
							<EmptyState size="inline" title="No logs yet" />
						) : (
							logs.map((log, i) => (
								<div
									key={
										// biome-ignore lint/suspicious/noArrayIndexKey: append-only log buffer; LogEvent has no per-event id and ts is not unique across same-ms bursts
										`${log.ts}-${i}`
									}
									className="flex flex-wrap items-baseline gap-x-2 font-mono"
								>
									<EventTime
										value={log.ts}
										className="shrink-0 whitespace-nowrap tabular-nums text-muted-foreground"
									/>
									<span
										data-tone={logLevelTone(log.level)}
										className={cn(
											"min-w-[7ch] shrink-0 font-medium",
											LEVEL_TEXT[logLevelTone(log.level)],
										)}
									>
										{logLevelLabel(log.level)}
									</span>
									<span className="min-w-0 basis-full break-words sm:flex-1">
										{log.msg}
									</span>
								</div>
							))
						)}
						<div ref={logsEndRef} />
					</section>
					<div className="mt-4 flex items-center gap-2">
						<input
							type="checkbox"
							id="autoscroll"
							checked={autoScroll}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
								setAutoScroll((e.target as HTMLInputElement).checked)
							}
							className="rounded border-gray-300"
						/>
						<label
							htmlFor="autoscroll"
							className="inline-flex min-h-11 items-center text-sm text-muted-foreground"
						>
							Auto-scroll to bottom
						</label>
					</div>
				</CardContent>
			</Card>
		</div>
	);
}
