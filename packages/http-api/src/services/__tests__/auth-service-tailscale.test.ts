import { describe, expect, test } from "bun:test";
import { type ApiKey, NodeCryptoUtils } from "@hov-router/types/api-key";
import { AuthService } from "../auth-service";
import type { DashboardIdentityVerifier } from "../tailscale-dashboard-auth";

const login = "operator@example.com";
const identity = () => ({ provider: "tailscale" as const, login });
const request = (path: string, init?: RequestInit) =>
	new Request(`http://localhost${path}`, init);

function service(verify?: DashboardIdentityVerifier, keys: ApiKey[] = []) {
	return new AuthService(
		{
			countActiveApiKeys: async () => 1,
			getActiveApiKeys: async () => keys,
			getApiKey: async (id: string) => keys.find((key) => key.id === id),
			updateApiKeyUsage: async () => {},
		} as never,
		undefined,
		undefined,
		verify,
	);
}

async function key(
	role: ApiKey["role"],
): Promise<{ raw: string; record: ApiKey }> {
	const raw = "test-router-key-for-tailnet-boundary";
	return {
		raw,
		record: {
			id: "00000000-0000-4000-8000-000000000001",
			name: "test-client",
			hashedKey: await new NodeCryptoUtils().hashApiKey(raw),
			prefixLast8: raw.slice(-8),
			createdAt: 0,
			lastUsed: null,
			usageCount: 0,
			isActive: true,
			role,
		},
	};
}

describe("verified Tailscale dashboard identity", () => {
	test("grants dashboard admin access without inventing an API key", async () => {
		const result = await service(identity).authenticateRequest(
			request("/api/accounts"),
			"/api/accounts",
			"GET",
		);
		expect(result.isAuthenticated).toBe(true);
		expect(result.role).toBe("admin");
		expect(result.dashboardIdentity).toEqual({ provider: "tailscale", login });
		expect(result.apiKey).toBeUndefined();
		expect(result.apiKeyId).toBeUndefined();
	});

	test("verifies the guard identity before waiting on the API-key database", async () => {
		const auth = new AuthService(
			{
				countActiveApiKeys: async () => {
					throw new Error("key reader unavailable");
				},
			} as never,
			undefined,
			undefined,
			identity,
		);
		const result = await auth.authenticateRequest(
			request("/api/accounts"),
			"/api/accounts",
			"GET",
		);
		expect(result.isAuthenticated).toBe(true);
		expect(result.dashboardIdentity?.login).toBe(login);
	});

	test("raw Tailscale headers do not authenticate ordinary ingress", async () => {
		const result = await service().authenticateRequest(
			request("/api/accounts", { headers: { "Tailscale-User-Login": login } }),
			"/api/accounts",
			"GET",
		);
		expect(result.isAuthenticated).toBe(false);
	});

	test("a verifier that rejects the request does not grant access", async () => {
		const result = await service(() => null).authenticateRequest(
			request("/api/accounts"),
			"/api/accounts",
			"GET",
		);
		expect(result.isAuthenticated).toBe(false);
	});

	test("dashboard identity cannot authorize inference or an unmatched proxy fallback", async () => {
		const auth = service(identity);
		for (const path of [
			"/v1/messages",
			"/messages/anything",
			"/other",
			"/api/not-a-route",
		]) {
			const req = request(path, { method: "POST" });
			const result = await auth.authenticateProxyRequest(req, path, "POST");
			expect(result.isAuthenticated).toBe(false);
		}
	});

	test("does not upgrade an explicitly supplied API-only key", async () => {
		const { raw, record } = await key("api-only");
		const auth = service(identity, [record]);
		const result = await auth.authenticateRequest(
			request("/api/accounts", { headers: { "x-api-key": raw } }),
			"/api/accounts",
			"GET",
		);
		expect(result.role).toBe("api-only");
		expect(result.dashboardIdentity).toBeUndefined();
		if (!result.apiKey) throw new Error("expected the original API key");
		expect(
			(await auth.authorizeEndpoint(result.apiKey, "/api/accounts", "GET"))
				.authorized,
		).toBe(false);
	});

	test("an invalid explicit credential is not silently replaced by dashboard identity", async () => {
		const result = await service(identity).authenticateRequest(
			request("/api/accounts", {
				headers: { Authorization: "Bearer invalid" },
			}),
			"/api/accounts",
			"GET",
		);
		expect(result.isAuthenticated).toBe(false);
	});

	test("keyless stream tokens require verified identity again and cannot escape to normal ingress", async () => {
		for (const audience of ["logs", "requests", "alerts"] as const) {
			const trusted = service(identity);
			const token = trusted.mintStreamToken(audience);
			const path = `/api/${audience}/stream`;
			const req = request(`${path}?stream_token=${token}`);
			expect(
				(await trusted.authenticateRequest(req, path, "GET")).isAuthenticated,
			).toBe(true);
			const ordinary = service();
			const ordinaryToken = ordinary.mintStreamToken(audience);
			expect(
				(
					await ordinary.authenticateRequest(
						request(`${path}?stream_token=${ordinaryToken}`),
						path,
						"GET",
					)
				).isAuthenticated,
			).toBe(false);
		}
	});
});
