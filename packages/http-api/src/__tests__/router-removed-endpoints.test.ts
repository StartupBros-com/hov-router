/**
 * Removed endpoints must answer 410 from the API router itself.
 *
 * An unmatched /api/* or /v1/* path makes APIRouter.handleRequest return null, and
 * server.ts then hands the request to the inference proxy, whose Anthropic
 * provider accepts every path. Without a local answer, a stale script calling
 * a removed endpoint would be forwarded upstream on a real account.
 *
 * Authentication is disabled here (no API keys) so each request reaches route
 * dispatch, the same as a local install that never created a key.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { APIContext } from "../types";

const scratch = mkdtempSync(join(tmpdir(), "hov-router-removed-endpoints-"));
process.env.HOV_ROUTER_DB_PATH = join(scratch, "test.db");
process.env.HOV_ROUTER_CONFIG_PATH = join(scratch, "config.json");
process.env.DATABASE_URL = "";
process.env.HOV_ROUTER_PUBLIC_SUBSCRIPTIONS = "";

const { APIRouter } = await import("../router");

function context(): APIContext {
	return {
		dbOps: {
			getAdapter: () => ({}),
			countActiveApiKeys: async () => 0,
			getActiveApiKeys: async () => [],
		},
		config: {},
	} as unknown as APIContext;
}

async function send(
	method: string,
	path: string,
	body?: unknown,
): Promise<Response | null> {
	const router = new APIRouter(context());
	const url = new URL(`http://localhost${path}`);
	return router.handleRequest(
		url,
		new Request(url, {
			method,
			...(body === undefined
				? {}
				: {
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(body),
					}),
		}),
	);
}

const REMOVED: Array<{
	method: string;
	path: string;
	body?: unknown;
	endpoint: string;
	replacement: string | null;
}> = [
	{
		method: "POST",
		path: "/api/accounts/muse-spark",
		endpoint: "/api/accounts/muse-spark",
		replacement: "POST /api/accounts/meta",
	},
	{
		method: "GET",
		path: "/api/config/model",
		endpoint: "/api/config/model",
		replacement: null,
	},
	{
		method: "POST",
		path: "/api/config/model",
		body: { model: "claude-sonnet-5-5" },
		endpoint: "/api/config/model",
		replacement: null,
	},
	{
		method: "POST",
		path: "/api/accounts/acct-1/auto-refresh",
		body: { enabled: false },
		endpoint: "/api/accounts/:id/auto-refresh",
		replacement: null,
	},
	{
		method: "POST",
		path: "/api/accounts/acct-1/model-fallbacks",
		body: { modelMappings: { sonnet: ["model-b"] } },
		endpoint: "/api/accounts/:id/model-fallbacks",
		replacement: "POST /api/accounts/:id/model-mappings",
	},
	{
		method: "GET",
		path: "/api/system/info",
		endpoint: "/api/system/info",
		replacement: null,
	},
	{
		method: "GET",
		path: "/api/workspaces",
		endpoint: "/api/workspaces",
		replacement: "GET /api/agents",
	},
	{
		method: "POST",
		path: "/api/debug/cache-diagnosis",
		body: {},
		endpoint: "/api/debug/cache-diagnosis",
		replacement: null,
	},
];

describe("removed endpoints", () => {
	for (const removed of REMOVED) {
		it(`${removed.method} ${removed.path} answers 410 locally`, async () => {
			const response = await send(removed.method, removed.path, removed.body);

			expect(response).not.toBeNull();
			expect(response?.status).toBe(410);
			const body = (await response?.json()) as {
				error: string;
				endpoint: string;
				removedIn: string;
				replacement: string | null;
				message: string;
			};
			expect(body.error).toBe("Gone");
			expect(body.endpoint).toBe(removed.endpoint);
			const version =
				removed.path === "/api/accounts/muse-spark" ? "7.0.0" : "5.0.0";
			expect(body.removedIn).toBe(version);
			expect(body.replacement).toBe(removed.replacement);
			expect(body.message).toContain("removed in");
			expect(body.message).toContain(version);
			if (removed.replacement) {
				expect(body.message).toContain(removed.replacement);
			}
		});
	}

	it("answers 410 for any method on a removed path, so none reaches the proxy", async () => {
		for (const method of ["HEAD", "PUT", "PATCH", "DELETE"]) {
			for (const path of [
				"/api/config/model",
				"/api/accounts/acct-1/auto-refresh",
				"/api/accounts/acct-1/model-fallbacks",
				// The removed handlers matched by path suffix at any depth.
				"/api/accounts/acct-1/x/model-fallbacks",
				"/api/system/info",
				"/api/workspaces",
				"/api/debug/cache-diagnosis",
			]) {
				expect((await send(method, path))?.status).toBe(410);
			}
		}
		expect((await send("GET", "/api/debug/cache-diagnosis"))?.status).toBe(410);
	});

	it("leaves the routes next to them alone", async () => {
		for (const [method, path] of [
			["GET", "/api/config/model-capacity-routing"],
			["POST", "/api/accounts/acct-1/model-mappings"],
			["GET", "/api/agents"],
			["GET", "/api/debug/cache-pacing"],
		] as const) {
			const response = await send(
				method,
				path,
				method === "POST" ? {} : undefined,
			);
			expect(response).not.toBeNull();
			expect(response?.status).not.toBe(410);
		}
		for (const path of [
			"/api/config/models",
			"/api/accounts/acct-1/auto-refresh/extra",
			"/api/accounts/acct-1/model-fallbacks-x",
			"/api/system/info/extra",
			"/api/workspaces/extra",
			"/api/debug/cache-diagnosis/extra",
		]) {
			expect((await send("GET", path))?.status).not.toBe(410);
		}
	});
});

describe("Auto quality lane controls removed in 6.0.0 (#816)", () => {
	it("answers 410 for the status and retry controls and names the stock replacement", async () => {
		for (const [method, path] of [
			["GET", "/v1/quality-routing/sessions/synthetic-session"],
			[
				"POST",
				"/v1/quality-routing/sessions/synthetic-session/retry-preferred",
			],
		] as const) {
			const response = await send(
				method,
				path,
				method === "POST" ? {} : undefined,
			);
			expect(response?.status).toBe(410);
			expect(response?.headers.get("cache-control")).toBe("no-store");
			const body = (await response?.json()) as Record<string, unknown>;
			expect(body).toMatchObject({
				error: "Gone",
				endpoint: "/v1/quality-routing/*",
				removedIn: "6.0.0",
				replacement: null,
			});
			expect(body.message).toContain("opus");
		}
	});

	it("reserves every form the removed handler classified, so none reaches the proxy", async () => {
		for (const path of [
			"/v1/quality-routing",
			"/v1/quality-routing-other",
			"/v1/quality-routing/sessions/%",
			"/v1/quality-routing/sessions/%2f",
			"/v1/%71uality-routing/sessions/synthetic-session",
			"/%761/quality-routing/sessions/synthetic-session",
		]) {
			for (const method of ["GET", "POST", "DELETE"]) {
				expect((await send(method, path))?.status).toBe(410);
			}
		}
	});

	it("leaves other /v1 paths to the proxy", async () => {
		for (const path of ["/v1/messages", "/v1/models", "/v1/quality"]) {
			expect((await send("GET", path))?.status).not.toBe(410);
		}
	});
});

describe("/api/insights endpoints removed or moved in 7.0.0 (#1012)", () => {
	// [requested path, endpoint named in the 410, replacement]
	const REMOVED_7 = [
		["/api/insights/cache", "/api/insights/cache", "GET /api/analytics"],
		["/api/insights/context", "/api/insights/context", null],
		["/api/insights/anomalies", "/api/insights/anomalies", null],
		["/api/insights/alerts", "/api/insights/alerts", "GET /api/alerts"],
		[
			"/api/insights/alerts/config",
			"/api/insights/alerts/config",
			"GET /api/alerts/config",
		],
		[
			"/api/insights/alerts/acknowledge-all",
			"/api/insights/alerts/acknowledge-all",
			"POST /api/alerts/acknowledge-all",
		],
		[
			"/api/insights/alerts/stream",
			"/api/insights/alerts/stream",
			"GET /api/alerts/stream",
		],
		[
			"/api/insights/alerts/stream/token",
			"/api/insights/alerts/stream/token",
			"POST /api/alerts/stream/token",
		],
		[
			"/api/insights/alerts/cache_health%3Aacct-1",
			"/api/insights/alerts/:id",
			"POST /api/alerts/:id",
		],
		[
			"/api/insights/cache-parity",
			"/api/insights/cache-parity",
			"GET /api/cache-parity",
		],
		// A trailing slash names the same endpoint.
		["/api/insights/alerts/", "/api/insights/alerts", "GET /api/alerts"],
		["/api/insights/cache/", "/api/insights/cache", "GET /api/analytics"],
	] as const;

	it("answers 410 for every method, with the replacement where one exists", async () => {
		for (const [path, endpoint, replacement] of REMOVED_7) {
			for (const method of ["GET", "HEAD", "POST", "DELETE"]) {
				const response = await send(
					method,
					`${path}?range=24h`,
					method === "POST" ? {} : undefined,
				);
				expect(response?.status).toBe(410);
				if (method === "HEAD") continue;
				const body = (await response?.json()) as Record<string, unknown>;
				expect(body).toMatchObject({
					error: "Gone",
					endpoint,
					removedIn: "7.0.0",
					replacement,
				});
			}
		}
	});

	// Nothing is served under /api/insights any more, so no path under it
	// may fall through to the inference proxy.
	it("answers 410 for any other path under /api/insights, encoded or not", async () => {
		for (const path of [
			"/api/insights",
			"/api/insights/",
			"/api/insights/cache/extra",
			"/api/insights/context-x",
			"/api/insights/anomalies/extra",
			"/api/insights/alerts/alert-1/extra",
			"/api/%69nsights/alerts",
			"/api/insights%2Falerts",
		]) {
			for (const method of ["GET", "POST", "DELETE"]) {
				const response = await send(method, path);
				expect(response?.status).toBe(410);
				const body = (await response?.json()) as Record<string, unknown>;
				expect(body.removedIn).toBe("7.0.0");
				expect(String(body.message)).toContain("/api/alerts");
			}
		}
	});

	it("leaves paths that only begin with the same letters alone", async () => {
		for (const path of ["/api/insightsx", "/api/insight"]) {
			expect((await send("GET", path))?.status).not.toBe(410);
		}
	});
});
