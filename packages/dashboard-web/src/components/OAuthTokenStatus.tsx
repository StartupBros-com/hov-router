import { reauthInstruction } from "@better-ccflare/core/reauth-instructions";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, RefreshCw, XCircle } from "lucide-react";
import { getAccountTokenHealthQueryOptions } from "../hooks/queries";
import { APIErrorBoundary } from "./ErrorBoundary";

interface OAuthTokenStatusProps {
	accountName: string;
	hasRefreshToken: boolean;
	/** Picks the re-login path the tooltip names. */
	provider?: string;
}

type TokenStatus =
	| "healthy"
	| "warning"
	| "critical"
	| "expired"
	| "no-refresh-token"
	| "loading"
	| "error"
	| "unknown";

export function OAuthTokenStatus({
	accountName,
	hasRefreshToken,
	provider,
}: OAuthTokenStatusProps) {
	// A shared query rather than a one-shot fetch: it re-checks whenever the
	// accounts data is invalidated, so a re-login clears the mark (#866).
	const { data } = useQuery({
		...getAccountTokenHealthQueryOptions(accountName),
		enabled: hasRefreshToken,
	});
	const status: TokenStatus = !hasRefreshToken
		? "no-refresh-token"
		: (data?.status ?? "loading");
	const message = data?.message ?? "Loading...";

	return (
		<OAuthTokenStatusView
			status={status}
			message={message}
			accountName={accountName}
			hasRefreshToken={hasRefreshToken}
			provider={provider}
		/>
	);
}

export function OAuthTokenStatusView({
	status,
	message,
	accountName,
	hasRefreshToken,
	provider,
}: OAuthTokenStatusProps & { status: TokenStatus; message: string }) {
	// Non-OAuth accounts have no token to report; a healthy or still-loading
	// token is not a problem, so the row stays quiet.
	if (!hasRefreshToken || status === "healthy" || status === "loading")
		return null;

	// Show loading during fallback attempt
	if (status === "error") {
		return (
			<span
				className="inline-flex items-center ml-2"
				title="OAuth refresh token status unknown - checking..."
			>
				<RefreshCw
					className="h-4 w-4 text-muted-foreground animate-spin"
					aria-hidden="true"
				/>
				<span className="sr-only">Checking OAuth token status</span>
			</span>
		);
	}

	const getIcon = () => {
		switch (status) {
			case "warning":
				return <AlertTriangle className="h-4 w-4 text-(--warning)" />;
			case "critical":
			case "expired":
				return <XCircle className="h-4 w-4 text-(--danger)" />;
			default:
				return <AlertTriangle className="h-4 w-4 text-muted-foreground" />;
		}
	};

	const getTooltip = () => {
		switch (status) {
			case "warning":
				return `OAuth token expiring soon - ${message}`;
			case "critical":
			case "expired":
				return `OAuth token expired - ${message} - To re-authenticate, ${reauthInstruction(provider ?? "", accountName, { hasRefreshToken, audience: "dashboard" })}`;
			default:
				return "OAuth token status unknown";
		}
	};

	return (
		<span className="inline-flex items-center ml-2" title={getTooltip()}>
			<span aria-hidden="true" className="inline-flex items-center">
				{getIcon()}
			</span>
			<span className="sr-only">{getTooltip()}</span>
		</span>
	);
}

/**
 * Wrapped OAuthTokenStatus with error boundary protection
 */
export function OAuthTokenStatusWithBoundary(props: OAuthTokenStatusProps) {
	return (
		<APIErrorBoundary>
			<OAuthTokenStatus {...props} />
		</APIErrorBoundary>
	);
}
