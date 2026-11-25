import { HttpError } from "@better-ccflare/http-common";
import {
	MutationCache,
	QueryCache,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
import { lazy, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { api } from "./api";
import { AccountsTab } from "./components/AccountsTab";
import { AgentsTab } from "./components/AgentsTab";
import { ApiKeyAuthDialog } from "./components/ApiKeyAuthDialog";
import { ApiKeysTab } from "./components/ApiKeysTab";
import { DeviceSetupJobCoordinator } from "./components/accounts/DeviceSetupJobCoordinator";
import { AlertsTab } from "./components/alerts/AlertsTab";
import { CombosTab } from "./components/combos/CombosTab";
import { DebugPanel } from "./components/DebugPanel";
import { LogsTab } from "./components/LogsTab";
import { Navigation } from "./components/navigation";
import { OverviewTab } from "./components/OverviewTab";
import { LazyPage } from "./components/page-shell";
import { RequestsTab } from "./components/RequestsTab";
import { RouteLanesTab } from "./components/route-lanes/RouteLanesTab";
import { SettingsTab } from "./components/SettingsTab";
import {
	RouterUnreachableView,
	StartupCheckingView,
} from "./components/StartupStatus";
import { PageHeader } from "./components/ui/page-header";
import { QUERY_CONFIG, REFRESH_INTERVALS } from "./constants";
import { ThemeProvider } from "./contexts/theme-context";
import { PAGE_META, pageMetaForPath } from "./lib/page-meta";
import {
	authenticateErrorMessage,
	isKeyRejection,
	runStartupCheck,
	STARTUP_SLOW_NOTICE_MS,
	startupRetryDelayMs,
} from "./lib/startup-check";
import "./index.css";

// The floating Debug panel captures console output for devices without
// devtools (phones). It is opt-in: load any dashboard URL with `?debug`.
// Read once at startup so it survives in-app navigation.
const DEBUG_PANEL_ENABLED =
	typeof window !== "undefined" &&
	new URLSearchParams(window.location.search).has("debug");

// Lazy load heavy components for better bundle splitting
const LazyAnalyticsTab = lazy(() =>
	import("./components/LazyAnalytics").then((module) => ({
		default: module.LazyAnalytics,
	})),
);
const LazyUsageHistoryTab = lazy(() =>
	import("./components/usage-history/UsageHistoryTab").then((m) => ({
		default: m.UsageHistoryTab,
	})),
);
const LazyWindowValueTab = lazy(() =>
	import("./components/window-value/WindowValueTab").then((m) => ({
		default: m.WindowValueTab,
	})),
);

// Each page renders its own header (PageHeader); titles and descriptions live in page-meta.
const ROUTES = [
	{ path: PAGE_META.overview.path, element: <OverviewTab /> },
	{
		path: PAGE_META.analytics.path,
		element: (
			<LazyPage page="analytics">
				<LazyAnalyticsTab />
			</LazyPage>
		),
	},
	{ path: PAGE_META.alerts.path, element: <AlertsTab /> },
	{ path: PAGE_META.requests.path, element: <RequestsTab /> },
	{ path: PAGE_META.accounts.path, element: <AccountsTab /> },
	{
		path: PAGE_META.usageHistory.path,
		element: (
			<LazyPage page="usageHistory">
				<LazyUsageHistoryTab />
			</LazyPage>
		),
	},
	{
		path: PAGE_META.windowValue.path,
		element: (
			<LazyPage page="windowValue">
				<LazyWindowValueTab />
			</LazyPage>
		),
	},
	{ path: PAGE_META.combos.path, element: <CombosTab /> },
	{ path: PAGE_META.routeLanes.path, element: <RouteLanesTab /> },
	{ path: PAGE_META.agents.path, element: <AgentsTab /> },
	{ path: PAGE_META.keys.path, element: <ApiKeysTab /> },
	{ path: PAGE_META.logs.path, element: <LogsTab /> },
	{ path: PAGE_META.settings.path, element: <SettingsTab /> },
];

// QueryClient will be created inside App component to have access to auth state

export function App() {
	const location = useLocation();
	const currentPage = pageMetaForPath(location.pathname);
	const [showAuthDialog, setShowAuthDialog] = useState(false);
	const [isAuthenticated, setIsAuthenticated] = useState(false);
	// "unreachable" means the startup request got no answer from the router;
	// the check keeps retrying until it does.
	const [startup, setStartup] = useState<
		| { phase: "checking" }
		| { phase: "unreachable"; message: string; retrying: boolean }
		| { phase: "done" }
	>({ phase: "checking" });
	const [slowCheck, setSlowCheck] = useState(false);
	const [checkRun, setCheckRun] = useState(0);
	const startupFailuresRef = useRef(0);
	const isCheckingAuth = startup.phase !== "done";
	const [authError, setAuthError] = useState<string | null>(null);
	const [authRequired, setAuthRequired] = useState(false);

	// Use refs to store state setters so they can be accessed in QueryClient callbacks
	const showAuthDialogRef = useRef(setShowAuthDialog);
	const isAuthenticatedRef = useRef(setIsAuthenticated);
	const authErrorRef = useRef(setAuthError);
	const authRequiredRef = useRef(setAuthRequired);

	// Update refs when setters change
	useEffect(() => {
		showAuthDialogRef.current = setShowAuthDialog;
		isAuthenticatedRef.current = setIsAuthenticated;
		authErrorRef.current = setAuthError;
		authRequiredRef.current = setAuthRequired;
	}, []);

	// Create QueryClient with global error handler for 401 errors
	const queryClient = useMemo(
		() =>
			new QueryClient({
				defaultOptions: {
					queries: {
						refetchInterval: REFRESH_INTERVALS.default,
						staleTime: QUERY_CONFIG.staleTime,
						retry: (failureCount, error) => {
							// Don't retry on 401 errors
							if (error instanceof HttpError && error.status === 401) {
								return false;
							}
							return failureCount < 2;
						},
					},
					mutations: {
						retry: false,
					},
				},
				queryCache: new QueryCache({
					onError: (error) => {
						// Show auth dialog on any 401 error
						if (error instanceof HttpError && error.status === 401) {
							console.log("[App] 401 error in query - showing auth dialog");
							api.clearApiKey();
							authErrorRef.current(null); // Clear any previous errors
							isAuthenticatedRef.current(false);
							authRequiredRef.current(true);
							showAuthDialogRef.current(true);
						}
					},
				}),
				mutationCache: new MutationCache({
					onError: (error) => {
						// Show auth dialog on any 401 error
						if (error instanceof HttpError && error.status === 401) {
							console.log("[App] 401 error in mutation - showing auth dialog");
							api.clearApiKey();
							authErrorRef.current(null); // Clear any previous errors
							isAuthenticatedRef.current(false);
							authRequiredRef.current(true);
							showAuthDialogRef.current(true);
						}
					},
				}),
			}),
		[],
	);

	useEffect(() => {
		const timer = setTimeout(() => setSlowCheck(true), STARTUP_SLOW_NOTICE_MS);
		return () => clearTimeout(timer);
	}, []);

	// Check if authentication is required. Always verify with a test request,
	// even with a stored key: the key might be invalid, deleted, or expired.
	// biome-ignore lint/correctness/useExhaustiveDependencies: each change of checkRun starts one attempt
	useEffect(() => {
		let cancelled = false;
		let retryTimer: ReturnType<typeof setTimeout> | undefined;
		setStartup((current) =>
			current.phase === "unreachable"
				? { ...current, retrying: true }
				: current,
		);
		void runStartupCheck(
			() => api.checkDashboardAccess(),
			() => api.hasApiKey(),
		).then((outcome) => {
			if (cancelled) return;
			if (outcome.kind === "unreachable") {
				// No answer, e.g. while a deploy swaps the backend and the guard
				// holds new requests. Say so and retry, never show an empty page.
				const delay = startupRetryDelayMs(startupFailuresRef.current);
				startupFailuresRef.current += 1;
				setStartup({
					phase: "unreachable",
					message: outcome.message,
					retrying: false,
				});
				retryTimer = setTimeout(() => setCheckRun((run) => run + 1), delay);
				return;
			}
			startupFailuresRef.current = 0;
			if (outcome.kind === "ready") {
				setIsAuthenticated(true);
				// Auth is required only if we got here with a stored key
				setAuthRequired(outcome.authRequired);
			} else {
				// Clear the rejected stored key
				api.clearApiKey();
				setAuthError(outcome.message);
				setAuthRequired(true);
				setShowAuthDialog(true);
			}
			setStartup({ phase: "done" });
		});
		return () => {
			cancelled = true;
			clearTimeout(retryTimer);
		};
	}, [checkRun]);

	// Listen for 401 errors from API client
	useEffect(() => {
		const handleAuthRequired = () => {
			api.clearApiKey();
			setAuthError(null);
			setIsAuthenticated(false);
			setAuthRequired(true);
			setShowAuthDialog(true);
		};

		window.addEventListener("auth-required", handleAuthRequired);
		return () =>
			window.removeEventListener("auth-required", handleAuthRequired);
	}, []);

	const handleAuthenticate = async (apiKey: string): Promise<boolean> => {
		setAuthError(null);

		// Store the API key
		api.setApiKey(apiKey);

		// Try to make a request to verify the key
		try {
			await api.checkDashboardAccess();
			setIsAuthenticated(true);
			setShowAuthDialog(false);
			return true;
		} catch (error) {
			// Clear the key only when the router rejected it; a timeout or 5xx
			// says nothing about the key.
			if (isKeyRejection(error)) api.clearApiKey();
			setAuthError(authenticateErrorMessage(error));
			return false;
		}
	};

	const handleLogout = () => {
		api.clearApiKey();
		setIsAuthenticated(false);
		setShowAuthDialog(true);
	};

	// Show loading state while checking authentication
	if (startup.phase === "checking") {
		return (
			<QueryClientProvider client={queryClient}>
				<ThemeProvider>
					<StartupCheckingView slow={slowCheck} />
				</ThemeProvider>
			</QueryClientProvider>
		);
	}

	if (startup.phase === "unreachable") {
		return (
			<QueryClientProvider client={queryClient}>
				<ThemeProvider>
					<RouterUnreachableView
						message={startup.message}
						retrying={startup.retrying}
						onRetry={() => setCheckRun((run) => run + 1)}
					/>
				</ThemeProvider>
			</QueryClientProvider>
		);
	}

	return (
		<QueryClientProvider client={queryClient}>
			<ThemeProvider>
				<DeviceSetupJobCoordinator authenticated={isAuthenticated} />
				<div className="min-h-screen bg-background">
					<Navigation onLogout={authRequired ? handleLogout : undefined} />

					{/* Main Content */}
					<main className="lg:pl-64">
						{/* Mobile spacer */}
						<div className="h-16 lg:hidden" />

						{/* Page Content */}
						<div className="p-4 md:p-6 lg:p-8 max-w-[1600px] mx-auto">
							{/* Pages mount only once auth is settled; until then, keep the current page's header in place. */}
							{!isCheckingAuth && isAuthenticated ? (
								<div className="animate-in fade-in-0 duration-200">
									<Routes>
										{ROUTES.map((route) => (
											<Route
												key={route.path}
												path={route.path}
												element={route.element}
											/>
										))}
										<Route
											path="/api-keys"
											element={<Navigate to="/keys" replace />}
										/>
										{/* The Insights page was removed in 7.0.0; its alert list lives on Alerts. */}
										<Route
											path="/insights"
											element={<Navigate to={PAGE_META.alerts.path} replace />}
										/>
										<Route path="*" element={<Navigate to="/" replace />} />
									</Routes>
								</div>
							) : (
								<PageHeader
									title={currentPage.title}
									description={currentPage.description}
								/>
							)}
						</div>
					</main>
				</div>
				{DEBUG_PANEL_ENABLED && <DebugPanel />}

				{/* API Key Authentication Dialog */}
				<ApiKeyAuthDialog
					isOpen={showAuthDialog}
					onAuthenticate={handleAuthenticate}
					error={authError}
				/>
			</ThemeProvider>
		</QueryClientProvider>
	);
}
