import { HttpError } from "@hov-router/http-common";
import { formatTokens } from "@hov-router/ui-common";
import { Eye } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type RequestPayload, type RequestSummary } from "../api";
import {
	attributionSourceLabel,
	describeRequestAgent,
} from "../lib/attribution";
import { ConversationView } from "./ConversationView";
import { CopyButton } from "./CopyButton";
import { RequestAgentBadge } from "./RequestAgentBadge";
import { RequestCostBadge } from "./RequestCostBadge";
import { RequestStatusPill } from "./requests/RequestStatusPill";
import { TokenUsageDisplay } from "./TokenUsageDisplay";
import { Badge } from "./ui/badge";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "./ui/dialog";
import { EventTime } from "./ui/event-time";
import { Label } from "./ui/label";
import { EmptyState, ErrorState, LoadingState } from "./ui/state";
import { StatusPill } from "./ui/status-pill";
import { Switch } from "./ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

interface RequestDetailsModalProps {
	request: RequestPayload;
	summary: RequestSummary | undefined;
	isOpen: boolean;
	onClose: () => void;
}

export function RequestDetailsModal({
	request,
	summary,
	isOpen,
	onClose,
}: RequestDetailsModalProps) {
	const [stored, setStored] = useState<RequestPayload | null>(null);
	const [failure, setFailure] = useState<PayloadLookupFailure | null>(null);

	const { effective, status } = resolvePayloadView(request, stored, failure);
	const lookUp = isOpen && status === "loading";

	useEffect(() => {
		if (!lookUp) return;
		let cancelled = false;
		api
			.getRequestPayload(request.id)
			.then((payload) => {
				if (!cancelled) setStored(payload);
			})
			.catch((err) => {
				if (cancelled) return;
				const missing = err instanceof HttpError && err.status === 404;
				setFailure({ id: request.id, kind: missing ? "missing" : "error" });
			});
		return () => {
			cancelled = true;
		};
	}, [lookUp, request.id]);

	return (
		<Dialog open={isOpen} onOpenChange={onClose}>
			<DialogContent className="max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
				<RequestDetailsPanel
					request={request}
					effective={effective}
					summary={summary}
					payloadStatus={status}
					onRetry={() => setFailure(null)}
				/>
			</DialogContent>
		</Dialog>
	);
}

/**
 * Where the dialog's request and response bodies stand:
 * - `ready`: `effective` holds them;
 * - `pending`: the request is still running, so nothing is looked up yet;
 * - `loading`: the stored payload is being fetched;
 * - `missing`: the server answered 404, so it stores no bodies for this request;
 * - `error`: the lookup failed some other way and can be retried.
 */
export type PayloadStatus =
	| "ready"
	| "pending"
	| "loading"
	| "missing"
	| "error";

export interface PayloadLookupFailure {
	id: string;
	kind: "missing" | "error";
}

/**
 * What the dialog shows for `request`. List rows arrive without bodies
 * (`bodiesOmitted`), failed rows included, so their stored payload is looked
 * up. The stored payload has no `error` field, so the row's error is kept.
 */
export function resolvePayloadView(
	request: RequestPayload,
	stored: RequestPayload | null,
	failure: PayloadLookupFailure | null,
): { effective: RequestPayload; status: PayloadStatus } {
	if (stored?.id === request.id) {
		return {
			effective: { ...stored, error: stored.error ?? request.error },
			status: "ready",
		};
	}
	if (request.request && request.meta?.bodiesOmitted !== true) {
		return { effective: request, status: "ready" };
	}
	if (request.meta?.pending) return { effective: request, status: "pending" };
	if (failure?.id === request.id) {
		return { effective: request, status: failure.kind };
	}
	return { effective: request, status: "loading" };
}

const decodeBase64 = (str: string | null): string => {
	if (!str) return "No data";
	try {
		const binary = atob(str);
		const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
		return new TextDecoder("utf-8").decode(bytes);
	} catch (error) {
		console.error("Failed to decode base64:", error, "Input:", str);
		return `Failed to decode: ${str}`;
	}
};

/**
 * A body for ConversationView: null when none was captured, never the
 * "No data" placeholder, which it would show as an assistant message.
 */
const decodeBodyOrNull = (body: string | null | undefined): string | null =>
	body ? decodeBase64(body) : null;

const formatJson = (str: string): string => {
	try {
		const parsed = JSON.parse(str);
		return JSON.stringify(parsed, null, 2);
	} catch {
		// If it's not valid JSON, return as-is
		return str;
	}
};

/**
 * Header and tabs of the request details dialog. `request` is what the list
 * handed over (its meta drives time, status and metadata); `effective` is the
 * stored payload once it has loaded.
 */
export function RequestDetailsPanel({
	request,
	effective,
	summary,
	payloadStatus,
	onRetry,
}: {
	request: RequestPayload;
	effective: RequestPayload;
	summary: RequestSummary | undefined;
	payloadStatus: PayloadStatus;
	onRetry?: () => void;
}) {
	const [beautifyMode, setBeautifyMode] = useState(true);

	const formatHeaders = (headers: Record<string, string>): string => {
		if (!beautifyMode) {
			return Object.entries(headers)
				.map(([key, value]) => `${key}: ${value}`)
				.join("\n");
		}
		return JSON.stringify(headers, null, 2);
	};

	const formatBody = (body: string | null): string => {
		const decoded = decodeBase64(body);
		if (!beautifyMode) return decoded;
		return formatJson(decoded);
	};

	const pending = Boolean(request.meta.pending);
	const isError = !pending && Boolean(effective.error || !request.meta.success);
	const statusCode = effective.response?.status ?? request.response?.status;
	const bodiesShown = payloadStatus === "ready";
	const payloadState = bodiesShown ? null : (
		<StoredPayloadState status={payloadStatus} onRetry={onRetry} />
	);
	const totalTokens = summary?.totalTokens;

	return (
		<>
			<DialogHeader>
				<DialogTitle className="flex items-center gap-2">
					<Eye className="h-5 w-5" aria-hidden="true" />
					Request Details
				</DialogTitle>
				<DialogDescription asChild>
					<div className="flex flex-wrap items-center justify-between gap-2">
						<div className="flex items-center gap-2 flex-wrap">
							<EventTime
								value={request.meta.timestamp}
								className="font-mono text-sm tabular-nums whitespace-nowrap"
							/>
							<RequestStatusPill
								statusCode={statusCode}
								pending={pending}
								isError={isError}
							/>
							{summary?.model && (
								<Badge variant="secondary">{summary.model}</Badge>
							)}
							{summary?.project &&
								(() => {
									const srcLabel = attributionSourceLabel(
										summary.projectAttributionSource,
									);
									return (
										<Badge variant="secondary">
											Project: {summary.project}
											{srcLabel ? ` · ${srcLabel}` : ""}
										</Badge>
									);
								})()}
							<RequestAgentBadge
								view={describeRequestAgent(
									summary?.agentUsed,
									summary?.agentAttributionSource,
								)}
							/>
							{typeof totalTokens === "number" && totalTokens > 0 && (
								<Badge variant="outline">
									{formatTokens(totalTokens)} tokens
								</Badge>
							)}
							<RequestCostBadge
								summary={summary}
								pending={request.meta.pending}
							/>
							{summary?.rateLimited && (
								<StatusPill tone="warning">Rate limited</StatusPill>
							)}
						</div>
						<div className="flex items-center gap-2">
							<Label
								htmlFor="beautify-mode"
								className="inline-flex min-h-11 items-center text-sm"
							>
								Beautify
							</Label>
							<Switch
								id="beautify-mode"
								checked={beautifyMode}
								onCheckedChange={setBeautifyMode}
							/>
						</div>
					</div>
				</DialogDescription>
			</DialogHeader>

			<Tabs defaultValue="conversation" className="flex-1 overflow-hidden">
				<TabsList className="flex h-auto w-full justify-start overflow-x-auto sm:grid sm:grid-cols-5">
					<TabsTrigger value="conversation" className="min-h-11 shrink-0">
						Conversation
					</TabsTrigger>
					<TabsTrigger value="request" className="min-h-11 shrink-0">
						Request
					</TabsTrigger>
					<TabsTrigger value="response" className="min-h-11 shrink-0">
						Response
					</TabsTrigger>
					<TabsTrigger value="metadata" className="min-h-11 shrink-0">
						Metadata
					</TabsTrigger>
					<TabsTrigger value="tokens" className="min-h-11 shrink-0">
						Token Usage
					</TabsTrigger>
				</TabsList>

				<TabsContent value="conversation" className="mt-4 flex-1 min-h-0">
					{payloadState ?? (
						<ConversationView
							requestBody={decodeBodyOrNull(effective.request?.body)}
							responseBody={decodeBodyOrNull(effective.response?.body)}
						/>
					)}
				</TabsContent>

				<TabsContent
					value="request"
					className="mt-4 space-y-4 overflow-y-auto max-h-[60vh]"
				>
					{payloadState ??
						(effective.request ? (
							<>
								<PayloadBlock
									title="Headers"
									copyLabel="Copy request headers"
									text={formatHeaders(effective.request.headers)}
								/>
								{effective.request.body && (
									<PayloadBlock
										title="Body"
										copyLabel="Copy request body"
										text={formatBody(effective.request.body)}
									/>
								)}
							</>
						) : (
							<div className="text-center text-muted-foreground py-8">
								No request data available
							</div>
						))}
				</TabsContent>

				<TabsContent
					value="response"
					className="mt-4 space-y-4 overflow-y-auto max-h-[60vh]"
				>
					{bodiesShown && !effective.response ? (
						<NoResponseMessage error={effective.error} />
					) : (
						<>
							{effective.error && <RequestErrorLine error={effective.error} />}
							{payloadState ??
								(effective.response && (
									<>
										<PayloadBlock
											title="Headers"
											copyLabel="Copy response headers"
											text={formatHeaders(effective.response.headers)}
										/>
										{effective.response.body && (
											<PayloadBlock
												title="Body"
												copyLabel="Copy response body"
												text={formatBody(effective.response.body)}
											/>
										)}
									</>
								))}
						</>
					)}
				</TabsContent>

				<TabsContent
					value="metadata"
					className="mt-4 overflow-y-auto max-h-[60vh]"
				>
					<PayloadBlock
						title="Request Metadata"
						copyLabel="Copy metadata"
						text={
							beautifyMode
								? JSON.stringify(request.meta, null, 2)
								: JSON.stringify(request.meta)
						}
					/>
				</TabsContent>

				<TabsContent
					value="tokens"
					className="mt-4 overflow-y-auto max-h-[60vh]"
				>
					<TokenUsageDisplay summary={summary} pending={request.meta.pending} />
				</TabsContent>
			</Tabs>
		</>
	);
}

/** One titled payload section with a copy button named after it. */
export function PayloadBlock({
	title,
	copyLabel,
	text,
}: {
	title: string;
	copyLabel: string;
	text: string;
}) {
	return (
		<div>
			<div className="flex items-center justify-between mb-2">
				<h3 className="font-semibold">{title}</h3>
				<CopyButton
					variant="ghost"
					size="touch-sm"
					label={copyLabel}
					getValue={() => text}
				>
					Copy
				</CopyButton>
			</div>
			<pre className="bg-muted p-4 rounded-lg overflow-x-auto text-sm font-mono">
				{text}
			</pre>
		</div>
	);
}

/** The Response tab when no response was recorded. */
export function NoResponseMessage({ error }: { error?: string }) {
	return (
		<div className="text-center text-muted-foreground py-8">
			{error ? (
				<>
					<RequestErrorLine error={error} />
					<p className="mt-2">No response data available</p>
				</>
			) : (
				<p>No response data available</p>
			)}
		</div>
	);
}

/** The request's recorded error, left-aligned so a long one wraps readably. */
function RequestErrorLine({ error }: { error: string }) {
	return (
		<p className="text-left text-destructive font-medium break-words">
			Error: {error}
		</p>
	);
}

/** What a payload tab shows until the stored bodies are in hand. */
function StoredPayloadState({
	status,
	onRetry,
}: {
	status: Exclude<PayloadStatus, "ready">;
	onRetry?: () => void;
}) {
	switch (status) {
		case "pending":
			return (
				<EmptyState
					title="Request still running"
					description="Its stored payload is looked up when it finishes."
				/>
			);
		case "loading":
			return <LoadingState label="Loading payload" rows={2} />;
		case "missing":
			return (
				<EmptyState
					title="No payload stored for this request"
					description="The server has no request or response bodies for it. Payload storage may be off, the save may have been skipped or failed, the bodies may have been cleaned up, or the request may still be running."
				/>
			);
		case "error":
			return (
				<ErrorState
					title="Couldn't load the stored payload"
					onRetry={onRetry}
				/>
			);
	}
}
