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
	| "error";

export function OAuthTokenStatus({
	accountName,
	hasRefreshToken,
	provider,
}: OAuthTokenStatusProps) {
	const [status, setStatus] = useState<TokenStatus>("loading");
	const [message, setMessage] = useState("Loading...");
	const [fallbackAttempted, setFallbackAttempted] = useState(false);

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
				} else {
					console.error("API returned error:", response);
					setStatus("error");
					setMessage("Failed to load token status");
				}
			} catch (error) {
				if (cancelled) return;
				console.error("Failed to fetch token status:", error);
				setStatus("error");
				setMessage("Failed to check token status");
			}
		};

		// Execute immediately without delay
		fetchTokenStatus();

		return () => {
			cancelled = true;
		};
	}, [accountName, hasRefreshToken]);

	// Fallback: if initial fetch fails, try global token health
	useEffect(() => {
		if (status === "error" && hasRefreshToken && !fallbackAttempted) {
			setFallbackAttempted(true);
			let cancelled = false;

			const checkGlobalHealth = async () => {
				try {
					const globalResponse = await api.getTokenHealth();
					if (cancelled) return;

					if (globalResponse?.success && globalResponse.data?.accounts) {
						const accountData = globalResponse.data.accounts.find(
							(acc: {
								accountName: string;
								status: TokenStatus;
								message: string;
							}) => acc.accountName === accountName,
						);
						if (accountData) {
							setStatus(accountData.status);
							setMessage(accountData.message);
						}
					}
				} catch (error) {
					if (cancelled) return;
					console.error("Failed to fetch global health:", error);
				}
			};

			checkGlobalHealth();

			return () => {
				cancelled = true;
			};
		}
	}, [status, accountName, hasRefreshToken, fallbackAttempted]);

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
					className="h-4 w-4 text-gray-400 animate-spin"
					aria-hidden="true"
				/>
				<span className="sr-only">Checking OAuth token status</span>
			</span>
		);
	}

	const getIcon = () => {
		switch (status) {
			case "warning":
				return <AlertTriangle className="h-4 w-4 text-yellow-600" />;
			case "critical":
			case "expired":
				return <XCircle className="h-4 w-4 text-red-600" />;
			default:
				return <AlertTriangle className="h-4 w-4 text-gray-500" />;
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
