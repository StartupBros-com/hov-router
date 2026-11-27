import { PRODUCT_NAME } from "@hov-router/core/product-identity";

/**
 * Removed API endpoints, answered with 410 Gone.
 *
 * APIRouter.handleRequest returns null for an unmatched /api/* path, and
 * server.ts then hands the request to the inference proxy, whose Anthropic
 * provider accepts every path. Without this answer, a stale script calling a
 * removed endpoint would be forwarded upstream on a real account. Every
 * method on these paths gets the 410, since none of them is served any more.
 *
 * Each removal is listed in docs/hov-router-migration.md.
 */
interface RemovedEndpoint {
	/** The path as documented, with :id for the account segment. */
	endpoint: string;
	/** The method and path that replaces it, or null when nothing does. */
	replacement: string | null;
	/** One sentence on what to do instead. */
	advice: string;
	/** The release that removed it. */
	removedIn: string;
}

const EXACT = new Map<string, RemovedEndpoint>([
	[
		"/api/accounts/muse-spark",
		{
			endpoint: "/api/accounts/muse-spark",
			removedIn: "7.0.0",
			replacement: "POST /api/accounts/meta",
			advice: "Use POST /api/accounts/meta to add a Meta account.",
		},
	],
	[
		"/api/config/model",
		{
			endpoint: "/api/config/model",
			removedIn: "5.0.0",
			replacement: null,
			advice:
				"The Default Agent Model setting did nothing and is gone; set per-agent models on the Agents tab.",
		},
	],
	[
		"/api/system/info",
		{
			endpoint: "/api/system/info",
			removedIn: "5.0.0",
			replacement: null,
			advice: "GET /health reports the running version and build SHA.",
		},
	],
	[
		"/api/workspaces",
		{
			endpoint: "/api/workspaces",
			removedIn: "5.0.0",
			replacement: "GET /api/agents",
			advice:
				"GET /api/agents returns the workspaces; count workspaceAgents by workspace for per-workspace totals.",
		},
	],
	[
		"/api/debug/cache-diagnosis",
		{
			endpoint: "/api/debug/cache-diagnosis",
			removedIn: "5.0.0",
			replacement: null,
			advice:
				"Cache diagnosis ran only when HOV_ROUTER_CACHE_DIAG was set, and that variable is now ignored.",
		},
	],
]);

const ACCOUNT_ACTIONS = new Map<string, RemovedEndpoint>([
	[
		"auto-refresh",
		{
			endpoint: "/api/accounts/:id/auto-refresh",
			removedIn: "5.0.0",
			replacement: null,
			advice:
				"Auto-refresh was removed in 4.0.0; a stored value is ignored and needs no clearing.",
		},
	],
	[
		"model-fallbacks",
		{
			endpoint: "/api/accounts/:id/model-fallbacks",
			removedIn: "5.0.0",
			replacement: "POST /api/accounts/:id/model-mappings",
			advice:
				"Send fallbacks as array values in POST /api/accounts/:id/model-mappings.",
		},
	],
]);

/**
 * The Auto quality lane's session controls (#816). Matched as a prefix after
 * decoding ASCII escapes, as the removed handler classified them, so no form it
 * answered falls through to the proxy.
 */
const QUALITY_ROUTING_PREFIX = "/v1/quality-routing";
const QUALITY_ROUTING: RemovedEndpoint = {
	endpoint: "/v1/quality-routing/*",
	removedIn: "6.0.0",
	replacement: null,
	advice:
		"The Auto quality lane is gone; send a stock model such as opus, or a route profile.",
};

/**
 * Everything the Insights page used lived under /api/insights (#1012). In
 * 7.0.0 its analysis endpoints were removed and the alert and cache-parity
 * routes moved out, unchanged, so nothing is served under the prefix any more
 * and every path under it answers 410. It is matched after decoding ASCII
 * escapes and ignoring a trailing slash, and each known path names its
 * replacement.
 */
const INSIGHTS_PREFIX = "/api/insights";
const INSIGHTS_ALERTS_PREFIX = "/api/insights/alerts/";

function moved(endpoint: string, replacement: string): RemovedEndpoint {
	return {
		endpoint,
		removedIn: "7.0.0",
		replacement,
		advice: `It moved to ${replacement}.`,
	};
}

const INSIGHTS = new Map<string, RemovedEndpoint>([
	[
		"/api/insights/cache",
		{
			endpoint: "/api/insights/cache",
			removedIn: "7.0.0",
			replacement: "GET /api/analytics",
			advice:
				"GET /api/analytics?modelBreakdown=true reports the cache hit rate per model over time.",
		},
	],
	[
		"/api/insights/context",
		{
			endpoint: "/api/insights/context",
			removedIn: "7.0.0",
			replacement: null,
			advice:
				"Context composition is gone; open a request on the Requests page to read its stored payload.",
		},
	],
	[
		"/api/insights/anomalies",
		{
			endpoint: "/api/insights/anomalies",
			removedIn: "7.0.0",
			replacement: null,
			advice:
				"Token anomaly detection is gone; the Requests and Analytics pages show per-request tokens and cost.",
		},
	],
	[
		"/api/insights/alerts",
		{
			endpoint: "/api/insights/alerts",
			removedIn: "7.0.0",
			replacement: "GET /api/alerts",
			advice:
				"It moved to /api/alerts: GET lists alerts and POST saves alert settings.",
		},
	],
	[
		"/api/insights/alerts/config",
		moved("/api/insights/alerts/config", "GET /api/alerts/config"),
	],
	[
		"/api/insights/alerts/acknowledge-all",
		moved(
			"/api/insights/alerts/acknowledge-all",
			"POST /api/alerts/acknowledge-all",
		),
	],
	[
		"/api/insights/alerts/stream",
		moved("/api/insights/alerts/stream", "GET /api/alerts/stream"),
	],
	[
		"/api/insights/alerts/stream/token",
		moved("/api/insights/alerts/stream/token", "POST /api/alerts/stream/token"),
	],
	[
		"/api/insights/cache-parity",
		moved("/api/insights/cache-parity", "GET /api/cache-parity"),
	],
]);
const INSIGHTS_ALERT = moved(
	"/api/insights/alerts/:id",
	"POST /api/alerts/:id",
);
const INSIGHTS_OTHER: RemovedEndpoint = {
	endpoint: "/api/insights/*",
	removedIn: "7.0.0",
	replacement: null,
	advice:
		"Nothing is served under /api/insights any more; the alert routes moved to /api/alerts and cache parity to /api/cache-parity.",
};

function findInsightsEndpoint(decoded: string): RemovedEndpoint | undefined {
	if (
		decoded !== INSIGHTS_PREFIX &&
		!decoded.startsWith(`${INSIGHTS_PREFIX}/`)
	) {
		return undefined;
	}
	const trimmed = decoded.endsWith("/") ? decoded.slice(0, -1) : decoded;
	const known = INSIGHTS.get(trimmed);
	if (known) return known;
	if (
		trimmed.startsWith(INSIGHTS_ALERTS_PREFIX) &&
		!trimmed.slice(INSIGHTS_ALERTS_PREFIX.length).includes("/")
	) {
		return INSIGHTS_ALERT;
	}
	return INSIGHTS_OTHER;
}

/** The removed endpoint this path names, or undefined if it names none. */
export function findRemovedEndpoint(path: string): RemovedEndpoint | undefined {
	const exact = EXACT.get(path);
	if (exact) return exact;
	const decoded = path.replace(/%([0-9a-f]{2})/gi, (_escape, hex: string) =>
		String.fromCharCode(Number.parseInt(hex, 16)),
	);
	if (decoded.startsWith(QUALITY_ROUTING_PREFIX)) return QUALITY_ROUTING;
	const insights = findInsightsEndpoint(decoded);
	if (insights) return insights;
	// Match the last segment under /api/accounts/, as the removed handlers'
	// path.endsWith() dispatch did, so no form they answered falls through.
	if (!path.startsWith("/api/accounts/")) return undefined;
	return ACCOUNT_ACTIONS.get(path.slice(path.lastIndexOf("/") + 1));
}

/** A 410 response for a removed endpoint. */
export function removedEndpointResponse(removed: RemovedEndpoint): Response {
	return Response.json(
		{
			error: "Gone",
			endpoint: removed.endpoint,
			removedIn: removed.removedIn,
			replacement: removed.replacement,
			message: `${removed.endpoint} was removed in ${PRODUCT_NAME} ${removed.removedIn}. ${removed.advice}`,
		},
		{ status: 410, headers: { "Cache-Control": "no-store" } },
	);
}
