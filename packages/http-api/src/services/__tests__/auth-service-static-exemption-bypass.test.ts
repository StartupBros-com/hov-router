/**
 * Regression coverage for three auth bypasses previously present in
 * isStaticPathExempt():
 *
 * 1. OAuth token-mutation bypass — every /api/oauth* path was blanket-exempt,
 *    so an unauthenticated caller could POST to init/reauth/callback and
 *    overwrite stored account OAuth tokens even with dashboard auth enabled.
 *
 * 2. Arbitrary-path proxy bypass — any path not starting with /api, /v1, or
 *    /messages was exempt (intended to let the dashboard serve its SPA/static
 *    assets). But this exemption lives in the SAME isPathExempt() consulted
 *    by the proxy fallback in apps/server/src/server.ts, so when the
 *    dashboard was disabled or its assets were unavailable, an arbitrary
 *    request (e.g. POST /foo) reached the upstream proxy handler
 *    unauthenticated.
 *
 * The fix removes both blanket exemptions. OAuth read-only status polling
 * (GET /api/oauth/{qwen,codex}/status/:id) remains exempt. The dashboard SPA
 * and static assets are now served by the server BEFORE authentication is
 * consulted at all (server.ts), so nothing legitimate needs an exemption at
 * this layer for non-API paths.
 *
 * 3. Method-unscoped exemptions — /health and /api/version/check were exempt
 *    for every method, but the router serves only their GET. Any other method
 *    passed authentication with no key, matched no API route, and reached the
 *    upstream proxy on a configured account. Both are now exempt for GET
 *    only.
 *
 * All three are one mistake: an exemption broader than the route it opens.
 * authenticateProxyRequest() is what the proxy fallback calls, and it refuses
 * a request whose only credential is an exemption for an API route, so the
 * next exemption that is too broad returns 401 instead of reaching a provider.
 */
import { describe, expect, it } from "bun:test";
import type { DatabaseOperations } from "@hov-router/database";
import { type ApiKey, NodeCryptoUtils } from "@hov-router/types/api-key";
import { AuthService } from "../auth-service";

const INTERNAL_PROBE_SECRET_HEADER = "x-hov-router-internal-probe-secret";
const LOCAL_CONTROL_SECRET_HEADER = "x-hov-router-local-control-secret";
const PROBE_SECRET = "test-internal-probe-secret";
const LOCAL_CONTROL_SECRET = "test-local-control-secret";
const NON_GET_METHODS = [
	"POST",
	"PUT",
	"PATCH",
	"DELETE",
	"HEAD",
	"OPTIONS",
] as const;

function makeDbOpsNoKeys(): DatabaseOperations {
	return {
		countActiveApiKeys: async () => 0,
		getActiveApiKeys: async () => [],
	} as unknown as DatabaseOperations;
}

function makeDbOpsWithApiKeys(): DatabaseOperations {
	return {
		countActiveApiKeys: async () => 1,
		getActiveApiKeys: async () => [],
	} as unknown as DatabaseOperations;
}

async function makeDbOpsWithKey(rawKey: string): Promise<DatabaseOperations> {
	const record: ApiKey = {
		id: "key-1",
		name: "test-key",
		hashedKey: await new NodeCryptoUtils().hashApiKey(rawKey),
		prefixLast8: rawKey.slice(-8),
		createdAt: 0,
		lastUsed: null,
		usageCount: 0,
		isActive: true,
		role: "admin",
	};
	return {
		countActiveApiKeys: async () => 1,
		getActiveApiKeys: async () => [record],
		updateApiKeyUsage: async () => {},
	} as unknown as DatabaseOperations;
}

describe("AuthService — static exemption bypass regression", () => {
	describe("OAuth endpoints", () => {
		it("isStaticPathExempt no longer blanket-exempts /api/oauth*", () => {
			const auth = new AuthService(makeDbOpsWithApiKeys());
			expect(auth.isStaticPathExempt("/api/oauth/init")).toBe(false);
			expect(auth.isStaticPathExempt("/api/oauth/callback")).toBe(false);
			expect(auth.isStaticPathExempt("/api/oauth/qwen/reauth")).toBe(false);
		});

		it("isPathExempt rejects token-mutating OAuth paths when auth is enabled", async () => {
			const auth = new AuthService(makeDbOpsWithApiKeys());
			expect(await auth.isPathExempt("/api/oauth/init", "POST")).toBe(false);
			expect(await auth.isPathExempt("/api/oauth/callback", "POST")).toBe(
				false,
			);
			expect(await auth.isPathExempt("/api/oauth/qwen/reauth", "POST")).toBe(
				false,
			);
			expect(await auth.isPathExempt("/api/oauth/codex/reauth", "POST")).toBe(
				false,
			);
			expect(
				await auth.isPathExempt("/api/oauth/anthropic/reauth/callback", "POST"),
			).toBe(false);
		});

		it("allows only exact GET Qwen and Codex status polling", async () => {
			const auth = new AuthService(makeDbOpsWithApiKeys());
			for (const path of [
				"/api/oauth/qwen/status/acct-1",
				"/api/oauth/codex/status/acct-1",
			]) {
				expect(await auth.isPathExempt(path, "GET")).toBe(true);
			}
		});

		it("rejects non-GET, malformed, other-provider, and prefix-lookalike status paths", async () => {
			const auth = new AuthService(makeDbOpsWithApiKeys());
			for (const [path, method] of [
				["/api/oauth/qwen/status/acct-1", "POST"],
				["/api/oauth/codex/status/acct-1", "DELETE"],
				["/api/oauth/qwen/status/acct-1/extra", "GET"],
				["/api/oauth/qwen/status/", "GET"],
				["/api/oauth/anthropic/status/acct-1", "GET"],
				["/api/oauth/qwen/statusish/acct-1", "GET"],
			] as const) {
				expect(await auth.isPathExempt(path, method)).toBe(false);
			}
		});

		it("authenticateRequest rejects unauthenticated OAuth mutation once keys exist", async () => {
			const auth = new AuthService(makeDbOpsWithApiKeys());
			const req = new Request("http://localhost/api/oauth/callback", {
				method: "POST",
			});
			const result = await auth.authenticateRequest(
				req,
				"/api/oauth/callback",
				"POST",
			);
			expect(result.isAuthenticated).toBe(false);
		});

		it("authenticateRequest still allows OAuth init during initial setup (no keys yet)", async () => {
			const auth = new AuthService(makeDbOpsNoKeys());
			const req = new Request("http://localhost/api/oauth/init", {
				method: "POST",
			});
			const result = await auth.authenticateRequest(
				req,
				"/api/oauth/init",
				"POST",
			);
			expect(result.isAuthenticated).toBe(true);
		});
	});

	describe("Arbitrary non-API paths", () => {
		it("isStaticPathExempt no longer exempts an arbitrary non-API path", () => {
			const auth = new AuthService(makeDbOpsWithApiKeys());
			expect(auth.isStaticPathExempt("/foo")).toBe(false);
			expect(auth.isStaticPathExempt("/dashboard")).toBe(false);
			expect(auth.isStaticPathExempt("/")).toBe(false);
			expect(auth.isStaticPathExempt("/static/logo.png")).toBe(false);
		});

		it("isPathExempt rejects an arbitrary non-API path when auth is enabled", async () => {
			const auth = new AuthService(makeDbOpsWithApiKeys());
			expect(await auth.isPathExempt("/foo", "POST")).toBe(false);
			expect(await auth.isPathExempt("/anything/else", "GET")).toBe(false);
		});

		it("authenticateRequest rejects an unauthenticated proxy-fallback path once keys exist", async () => {
			const auth = new AuthService(makeDbOpsWithApiKeys());
			const req = new Request("http://localhost/foo", { method: "POST" });
			const result = await auth.authenticateRequest(req, "/foo", "POST");
			expect(result.isAuthenticated).toBe(false);
		});

		it("only exact /health remains statically exempt", () => {
			const auth = new AuthService(makeDbOpsWithApiKeys());
			expect(auth.isStaticPathExempt("/health")).toBe(true);
			expect(auth.isStaticPathExempt("/healthz")).toBe(false);
			expect(auth.isStaticPathExempt("/health/check")).toBe(false);
		});
	});

	describe("Exemptions scoped to the method their route serves", () => {
		const GET_ONLY_PATHS = ["/health", "/api/version/check"] as const;

		it("exempts /health and /api/version/check for GET only", async () => {
			const auth = new AuthService(makeDbOpsWithApiKeys());
			for (const path of GET_ONLY_PATHS) {
				expect(await auth.isPathExempt(path, "GET")).toBe(true);
				for (const method of NON_GET_METHODS) {
					expect(auth.isStaticPathExempt(path, method)).toBe(false);
					expect(await auth.isPathExempt(path, method)).toBe(false);
				}
			}
		});

		it("keeps both exempt when the method is omitted, like the other static exemptions", () => {
			const auth = new AuthService(makeDbOpsWithApiKeys());
			for (const path of GET_ONLY_PATHS) {
				expect(auth.isStaticPathExempt(path)).toBe(true);
			}
		});

		it("authenticateRequest rejects a keyless non-GET to either path once keys exist", async () => {
			const auth = new AuthService(makeDbOpsWithApiKeys());
			for (const path of GET_ONLY_PATHS) {
				for (const method of NON_GET_METHODS) {
					const req = new Request(`http://localhost${path}`, { method });
					const result = await auth.authenticateRequest(req, path, method);
					expect(result.isAuthenticated).toBe(false);
				}
			}
		});

		it("authenticateRequest still serves a keyless GET to both once keys exist", async () => {
			const auth = new AuthService(makeDbOpsWithApiKeys());
			for (const path of GET_ONLY_PATHS) {
				const req = new Request(`http://localhost${path}`);
				const result = await auth.authenticateRequest(req, path, "GET");
				expect(result.isAuthenticated).toBe(true);
				expect(result.exemption).toBe("api-route");
			}
		});
	});

	describe("authenticateProxyRequest — the proxy fallback's door", () => {
		// Every request below passes authenticateRequest() with no key. The
		// router serves each one, so none should ever arrive at the proxy
		// fallback; if one does, its exemption must not carry it upstream.
		const API_ROUTE_EXEMPT: ReadonlyArray<
			readonly [path: string, method: string, headers?: Record<string, string>]
		> = [
			["/health", "GET"],
			["/api/version/check", "GET"],
			["/api/public/subscription-value", "GET"],
			["/api/sessions/session-1/account", "GET"],
			["/api/oauth/qwen/status/job-1", "GET"],
			["/api/oauth/codex/status/job-1", "GET"],
			[
				"/api/accounts/acct-1/reload",
				"POST",
				{ [LOCAL_CONTROL_SECRET_HEADER]: LOCAL_CONTROL_SECRET },
			],
		];

		function makeAuth(dbOps: DatabaseOperations): AuthService {
			return new AuthService(dbOps, PROBE_SECRET, LOCAL_CONTROL_SECRET);
		}

		it("refuses a request whose only credential is an API-route exemption", async () => {
			const auth = makeAuth(makeDbOpsWithApiKeys());
			for (const [path, method, headers] of API_ROUTE_EXEMPT) {
				const req = new Request(`http://localhost${path}`, { method, headers });
				const forRouter = await auth.authenticateRequest(req, path, method);
				expect(forRouter.isAuthenticated).toBe(true);
				expect(forRouter.exemption).toBe("api-route");

				const forProxy = await auth.authenticateProxyRequest(req, path, method);
				expect(forProxy.isAuthenticated).toBe(false);
				expect(forProxy.error).toContain("API key required");
			}
		});

		it("admits the cache-keepalive self-loop on a proxy endpoint", async () => {
			const auth = makeAuth(makeDbOpsWithApiKeys());
			for (const path of ["/v1/messages", "/messages/count_tokens"]) {
				const req = new Request(`http://localhost${path}`, {
					method: "POST",
					headers: {
						[INTERNAL_PROBE_SECRET_HEADER]: PROBE_SECRET,
						"x-hov-router-keepalive": "true",
					},
				});
				const result = await auth.authenticateProxyRequest(req, path, "POST");
				expect(result.isAuthenticated).toBe(true);
				expect(result.exemption).toBe("internal-probe");
			}
		});

		it("does not let the keepalive secret open a path outside the proxy endpoints", async () => {
			const auth = makeAuth(makeDbOpsWithApiKeys());
			for (const path of ["/health", "/api/version/check", "/foo"]) {
				const req = new Request(`http://localhost${path}`, {
					method: "POST",
					headers: {
						[INTERNAL_PROBE_SECRET_HEADER]: PROBE_SECRET,
						"x-hov-router-keepalive": "true",
					},
				});
				const result = await auth.authenticateProxyRequest(req, path, "POST");
				expect(result.isAuthenticated).toBe(false);
			}
		});

		it("admits a validated key with its identity, on any path", async () => {
			const rawKey = "btr-0123456789abcdef0123456789abcdef";
			const auth = makeAuth(await makeDbOpsWithKey(rawKey));
			for (const [path, method] of [
				["/v1/messages", "POST"],
				["/health", "POST"],
				["/api/event_logging/batch", "POST"],
			] as const) {
				const req = new Request(`http://localhost${path}`, {
					method,
					headers: { "x-api-key": rawKey },
				});
				const result = await auth.authenticateProxyRequest(req, path, method);
				expect(result.isAuthenticated).toBe(true);
				expect(result.apiKeyId).toBe("key-1");
				expect(result.exemption).toBeUndefined();
			}
		});

		it("rejects a missing or wrong key exactly as authenticateRequest does", async () => {
			const auth = makeAuth(
				await makeDbOpsWithKey("btr-0123456789abcdef0123456789abcdef"),
			);
			for (const headers of [
				undefined,
				{ "x-api-key": "btr-ffffffffffffffffffffffff89abcdef" },
			]) {
				const req = new Request("http://localhost/v1/messages", {
					method: "POST",
					headers,
				});
				const result = await auth.authenticateProxyRequest(
					req,
					"/v1/messages",
					"POST",
				);
				expect(result.isAuthenticated).toBe(false);
			}
		});

		it("leaves an install with no keys open, exempt paths included", async () => {
			const auth = makeAuth(makeDbOpsNoKeys());
			for (const [path, method] of [
				["/v1/messages", "POST"],
				["/health", "POST"],
				["/health", "GET"],
				["/api/sessions/session-1/account", "GET"],
			] as const) {
				const req = new Request(`http://localhost${path}`, { method });
				const result = await auth.authenticateProxyRequest(req, path, method);
				expect(result.isAuthenticated).toBe(true);
			}
		});
	});
});
