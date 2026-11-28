import { beforeEach, describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { TAILSCALE_DASHBOARD_HEADER } from "@hov-router/http-common";
import { createTailscaleDashboardVerifier } from "../services/tailscale-dashboard-auth";
import "@hov-router/core";
import { type ApiKey, NodeCryptoUtils } from "@hov-router/types/api-key";
import { APIRouter } from "../router";
import type { APIContext } from "../types";

const ADMIN = "test-stream-admin";
const API_ONLY = "test-stream-api-only";
const streamPaths = {
	logs: "/api/logs/stream",
	requests: "/api/requests/stream",
	alerts: "/api/alerts/stream",
} as const;
type Audience = keyof typeof streamPaths;
let keys: ApiKey[];
let router: APIRouter;
let context: APIContext;

beforeEach(async () => {
	const crypto = new NodeCryptoUtils();
	keys = await Promise.all(
		[ADMIN, API_ONLY].map(async (raw, index) => ({
			id: String(index),
			name: raw,
			hashedKey: await crypto.hashApiKey(raw),
			prefixLast8: raw.slice(-8),
			role: index === 0 ? ("admin" as const) : ("api-only" as const),
			isActive: true,
			createdAt: 0,
			lastUsed: null,
			usageCount: 0,
		})),
	);
	context = {
		config: {
			getStrategy: () => "session",
			getStrategySource: () => "config",
		},
		dbOps: {
			getAdapter: () => ({}),
			countActiveApiKeys: async () => keys.filter((key) => key.isActive).length,
			getActiveApiKeys: async () => keys.filter((key) => key.isActive),
			getApiKey: async (id: string) =>
				keys.find((key) => key.id === id) ?? null,
			updateApiKeyUsage: () => {},
		},
	} as unknown as APIContext;
	router = new APIRouter(context);
});

async function request(path: string, method = "GET", key?: string) {
	const url = new URL(`http://localhost${path}`);
	const response = await router.handleRequest(
		url,
		new Request(url, {
			method,
			headers: key ? { "x-api-key": key } : {},
		}),
	);
	if (!response) throw new Error(`No route for ${path}`);
	return response;
}
async function mint(audience: Audience, key = ADMIN) {
	const response = await request(`${streamPaths[audience]}/token`, "POST", key);
	expect(response.status).toBe(200);
	return (await response.json()).token as string;
}
async function expectStream(path: string, key?: string) {
	const response = await request(path, "GET", key);
	try {
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
	} finally {
		await response.body?.cancel();
	}
}

describe("Tailscale dashboard route integration", () => {
	const secret = Buffer.alloc(32, 13);
	const origin = "https://router.example.test";
	async function signedRequest(path: string, method = "GET", key?: string) {
		const payload = Buffer.from(
			JSON.stringify({
				login: "operator@example.test",
				origin,
				method,
				path,
				issuedAt: Date.now(),
			}),
		).toString("base64url");
		const signature = createHmac("sha256", secret)
			.update(`hov-router/tailscale-dashboard/v1\n${payload}`)
			.digest("base64url");
		const headers = new Headers({
			origin,
			[TAILSCALE_DASHBOARD_HEADER]: `v1.${payload}.${signature}`,
		});
		if (key) headers.set("x-api-key", key);
		const url = new URL(`http://localhost${path}`);
		const response = await router.handleRequest(
			url,
			new Request(url, { method, headers }),
		);
		if (!response) throw new Error(`No route for ${path}`);
		return response;
	}
	beforeEach(() => {
		router = new APIRouter(context, {
			dashboardIdentityVerifier: createTailscaleDashboardVerifier(secret),
		});
	});
	it("opens the dashboard startup endpoint without a key but retains explicit key roles", async () => {
		const path = "/api/config/strategy";
		const response = await signedRequest(path);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			strategy: "session",
			strategySource: "config",
		});
		expect((await request(path)).status).toBe(401);
		expect((await signedRequest(path, "GET", API_ONLY)).status).toBe(401);
		expect((await signedRequest(path, "GET", "invalid")).status).toBe(401);
		expect((await signedRequest(path, "GET", ADMIN)).status).toBe(200);
	});
	for (const audience of ["logs", "requests", "alerts"] as const) {
		it(`${audience}: trusted identity opens the real stream; its token alone cannot`, async () => {
			const minted = await signedRequest(
				`${streamPaths[audience]}/token`,
				"POST",
			);
			expect(minted.status).toBe(200);
			const { token } = await minted.json();
			const path = `${streamPaths[audience]}?stream_token=${token}`;
			expect((await request(path)).status).toBe(401);
			const response = await signedRequest(path);
			try {
				expect(response.status).toBe(200);
				expect(response.headers.get("content-type")).toContain(
					"text/event-stream",
				);
			} finally {
				await response.body?.cancel();
			}
		});
	}
});

describe("router stream-token authentication and authorization", () => {
	for (const audience of ["logs", "requests", "alerts"] as const) {
		it(`${audience}: admin mints an ephemeral token and opens exactly one stream`, async () => {
			const token = await mint(audience);
			expect(token).toMatch(/^[a-f0-9]{64}$/);
			const path = `${streamPaths[audience]}?stream_token=${token}`;
			await expectStream(path);
			expect((await request(path)).status).toBe(401);
		});
		it(`${audience}: anonymous and API-only keys cannot mint or stream`, async () => {
			for (const key of [undefined, API_ONLY]) {
				expect(
					(await request(`${streamPaths[audience]}/token`, "POST", key)).status,
				).toBe(401);
				expect((await request(streamPaths[audience], "GET", key)).status).toBe(
					401,
				);
			}
		});
		it(`${audience}: header fallback and no-auth bootstrap still work`, async () => {
			await expectStream(
				`${streamPaths[audience]}?stream_token=invalid`,
				ADMIN,
			);
			keys = [];
			await expectStream(streamPaths[audience]);
			expect(
				(await request(`${streamPaths[audience]}/token`, "POST")).status,
			).toBe(200);
		});
		for (const other of ["logs", "requests", "alerts"] as const) {
			if (other === audience) continue;
			it(`${audience}: rejects ${other} audience and burns the token`, async () => {
				const token = await mint(audience);
				expect(
					(await request(`${streamPaths[other]}?stream_token=${token}`)).status,
				).toBe(401);
				expect(
					(await request(`${streamPaths[audience]}?stream_token=${token}`))
						.status,
				).toBe(401);
			});
		}
		for (const change of ["downgrade", "revoke", "delete"] as const) {
			it(`${audience}: rejects an issuer after ${change} with another key still active`, async () => {
				const token = await mint(audience);
				if (change === "downgrade") keys[0].role = "api-only";
				if (change === "revoke") keys[0].isActive = false;
				if (change === "delete") keys.shift();
				expect(
					(await request(`${streamPaths[audience]}?stream_token=${token}`))
						.status,
				).toBe(401);
			});
		}
	}
});
