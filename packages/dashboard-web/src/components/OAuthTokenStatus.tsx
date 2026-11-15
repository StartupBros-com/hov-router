import { reauthInstruction } from "@better-ccflare/core/reauth-instructions";
import { AlertTriangle, RefreshCw, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
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
	const [status, setStatus] = useState<TokenStatus>("loading");
	const [message, setMessage] = useState("Loading...");

	useEffect(() => {
		if (!hasRefreshToken) {
			// Immediately set status for non-OAuth accounts
			setStatus("no-refresh-token");
			setMessage("This account type doesn't support token health monitoring");
			return;
		}

		// Add cancellation only - no artificial delay for better UX
		let cancelled = false;

		const fetchTokenStatus = async () => {
			if (cancelled) return;

			try {
				const response = await api.getAccountTokenHealth(accountName);
				if (cancelled) return;
				if (response?.success) {
					setStatus(response.data.status);
					setMessage(response.data.message);
					return;
				}
			} catch (error) {
				if (cancelled) return;
				console.error("Failed to fetch token status:", error);
			}
			setStatus("error");
			try {
				const response = await api.getTokenHealth();
				if (cancelled) return;
				const account = response?.success
					? response.data?.accounts?.find(
							(row) => row.accountName === accountName,
						)
					: undefined;
				if (account) {
					setStatus(account.status);
					setMessage(account.message);
					return;
				}
			} catch (error) {
				if (cancelled) return;
				console.error("Failed to fetch global health:", error);
			}
			setStatus("unknown");
			setMessage("OAuth token status unavailable");
		};

		// Execute immediately without delay
		fetchTokenStatus();

		return () => {
			cancelled = true;
		};
	}, [accountName, hasRefreshToken]);

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
