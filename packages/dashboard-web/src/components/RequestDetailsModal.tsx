import { HttpError } from "@better-ccflare/http-common";
import { formatTokens } from "@better-ccflare/ui-common";
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
	const [hydrated, setHydrated] = useState<RequestPayload | null>(null);
	const [failedId, setFailedId] = useState<string | null>(null);

	const effective: RequestPayload =
		hydrated && hydrated.id === request.id ? hydrated : request;

	// Hydrate when we have no request payload at all (legacy case), or when
	// the list view handed us a body-less summary placeholder.
	const needsHydration =
		isOpen &&
		!effective.error &&
		!effective.meta?.pending &&
		(!effective.request || effective.meta?.bodiesOmitted === true) &&
		failedId !== request.id;

	useEffect(() => {
		if (!needsHydration) return;
		let cancelled = false;
		api
			.getRequestPayload(request.id)
			.then((payload) => {
				if (!cancelled) setHydrated(payload);
			})
			.catch((err) => {
				if (!cancelled && err instanceof HttpError && err.status === 404)
					setFailedId(request.id);
			});
		return () => {
			cancelled = true;
		};
	}, [needsHydration, request.id]);

	return (
		<Dialog open={isOpen} onOpenChange={onClose}>
			<DialogContent className="max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
				<RequestDetailsPanel
					request={request}
					effective={effective}
					summary={summary}
					needsHydration={needsHydration}
					payloadMissing={failedId === request.id}
				/>
			</DialogContent>
		</Dialog>
	);
}

const decodeBase64 = (str: string | null): string => {
	if (!str) return "No data";
	try {
		if (str === "[streamed]") {
			return "[Streaming data not captured]";
		}
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
 * hydrated payload when one has loaded.
 */
export function RequestDetailsPanel({
	request,
	effective,
	summary,
	needsHydration,
	payloadMissing = false,
}: {
	request: RequestPayload;
	effective: RequestPayload;
	summary: RequestSummary | undefined;
	needsHydration: boolean;
	/** The payload lookup answered 404: the server holds no bodies for this request. */
	payloadMissing?: boolean;
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
	const statusCode = effective.response?.status;
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
					{payloadMissing ? (
						<div className="flex h-32 flex-col items-center justify-center gap-1 text-center">
							<p className="text-muted-foreground">
								No payload stored for this request
							</p>
							<p className="text-xs text-muted-foreground">
								Payloads older than the retention window are deleted, and none
								are stored while payload storage is off.
							</p>
						</div>
					) : (
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
					{effective.request ? (
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
							{needsHydration
								? "Loading payload…"
								: "No request data available"}
						</div>
					)}
				</TabsContent>

				<TabsContent
					value="response"
					className="mt-4 space-y-4 overflow-y-auto max-h-[60vh]"
				>
					{effective.response ? (
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
					) : (
						<NoResponseMessage error={effective.error} />
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
					<p className="text-left text-destructive font-medium break-words">
						Error: {error}
					</p>
					<p className="mt-2">No response data available</p>
				</>
			) : (
				<p>No response data available</p>
			)}
		</div>
	);
}
