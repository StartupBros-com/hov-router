import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { TAILSCALE_DASHBOARD_HEADER } from "@hov-router/http-common";
import { createTailscaleDashboardVerifier } from "../tailscale-dashboard-auth";

const secret = Buffer.alloc(32, 7);
const now = 1_800_000_000_000;
const origin = "https://router.example.ts.net";
const login = "operator@example.com";
const baseClaim = {
	login,
	origin,
	method: "GET",
	path: "/api/accounts",
	issuedAt: now,
};

function proof(overrides: Record<string, unknown> = {}, key = secret) {
	const payload = Buffer.from(
		JSON.stringify({ ...baseClaim, ...overrides }),
	).toString("base64url");
	const signature = createHmac("sha256", key)
		.update(`hov-router/tailscale-dashboard/v1\n${payload}`)
		.digest("base64url");
	return `v1.${payload}.${signature}`;
}

function req(value = proof(), path = "/api/accounts", init: RequestInit = {}) {
	const headers = new Headers(init.headers);
	headers.set(TAILSCALE_DASHBOARD_HEADER, value);
	return new Request(`http://localhost${path}`, { ...init, headers });
}

const verify = createTailscaleDashboardVerifier(secret, () => now);

describe("guard-signed Tailscale dashboard identity", () => {
	test("accepts the request-bound proof without an API key", () => {
		expect(verify(req())).toEqual({ provider: "tailscale", login });
	});

	test("fails closed without the shared guard secret", () => {
		expect(
			createTailscaleDashboardVerifier(undefined, () => now)(req()),
		).toBeNull();
		expect(
			createTailscaleDashboardVerifier(Buffer.alloc(1), () => now)(req()),
		).toBeNull();
	});

	test("rejects spoofed, tampered, multivalued, and malformed envelopes", () => {
		for (const value of [
			"forged",
			proof({}, Buffer.alloc(32, 8)),
			`${proof()}=`,
			`${proof()}.extra`,
			`${proof()}, ${proof()}`,
			proof().replace("v1.", "v2."),
			"x".repeat(4097),
		])
			expect(verify(req(value))).toBeNull();
		const [version, payload, signature] = proof().split(".");
		const tampered = Buffer.from(
			JSON.stringify({ ...baseClaim, login: "attacker@example.com" }),
		).toString("base64url");
		expect(verify(req(`${version}.${tampered}.${signature}`))).toBeNull();
		expect(verify(req(`${version}.${payload}.a`))).toBeNull();
	});

	test("does not accept raw Tailscale identity or forwarded-host headers", () => {
		expect(
			verify(
				new Request("http://localhost/api/accounts", {
					headers: {
						"Tailscale-User-Login": login,
						"X-Forwarded-Host": new URL(origin).host,
					},
				}),
			),
		).toBeNull();
	});

	test("binds the proof to the method, exact path, and query", () => {
		expect(verify(req(proof(), "/api/api-keys"))).toBeNull();
		expect(verify(req(proof(), "/api/accounts?other=1"))).toBeNull();
		expect(
			verify(
				req(proof(), "/api/accounts", {
					method: "DELETE",
					headers: { origin },
				}),
			),
		).toBeNull();
		expect(
			verify(
				req(
					proof({ path: "/api/accounts?sort=name" }),
					"/api/accounts?sort=name",
				),
			),
		).not.toBeNull();
		for (const path of [
			"/v1/messages",
			"/messages",
			"/api",
			"/api/../v1/messages",
		]) {
			expect(verify(req(proof({ path }), path))).toBeNull();
		}
	});

	test("rejects expired and future proofs", () => {
		expect(verify(req(proof({ issuedAt: now - 30_001 })))).toBeNull();
		expect(verify(req(proof({ issuedAt: now + 5_001 })))).toBeNull();
		expect(verify(req(proof({ issuedAt: now - 30_000 })))).not.toBeNull();
	});

	test("requires the configured HTTPS origin for mutations", () => {
		const value = proof({ method: "POST" });
		for (const headers of [
			{},
			{ origin: "null" },
			{ origin: "https://evil.example" },
		]) {
			expect(
				verify(req(value, "/api/accounts", { method: "POST", headers })),
			).toBeNull();
		}
		expect(
			verify(
				req(value, "/api/accounts", { method: "POST", headers: { origin } }),
			),
		).not.toBeNull();
	});

	test("rejects cross-origin reads and cross-site resource loads", () => {
		expect(
			verify(
				req(proof(), "/api/accounts", {
					headers: { origin: "https://evil.example" },
				}),
			),
		).toBeNull();
		expect(
			verify(
				req(proof(), "/api/accounts", {
					headers: { "sec-fetch-site": "cross-site" },
				}),
			),
		).toBeNull();
		expect(
			verify(
				req(proof(), "/api/accounts", {
					headers: { origin, "sec-fetch-site": "same-origin" },
				}),
			),
		).not.toBeNull();
	});

	test("rejects a same-site image request without Origin, even with a valid proof", () => {
		const path = "/api/debug/snapshot";
		expect(
			verify(
				req(proof({ path }), path, {
					headers: {
						"sec-fetch-site": "same-site",
						"sec-fetch-mode": "no-cors",
						"sec-fetch-dest": "image",
					},
				}),
			),
		).toBeNull();
	});

	test("rejects invalid signed identity and origin claims", () => {
		for (const overrides of [
			{ login: "" },
			{ login: "a,b" },
			{ login: "a\nb" },
			{ login: "x".repeat(321) },
			{ login: 1 },
			{ origin: "http://router.example.ts.net" },
			{ origin: `${origin}/` },
			{ issuedAt: "1800000000000" },
			{ issuedAt: 0.5 },
		])
			expect(verify(req(proof(overrides)))).toBeNull();
	});

	test("holds an immutable copy of the secret", () => {
		const mutable = Buffer.from(secret);
		const fixed = createTailscaleDashboardVerifier(mutable, () => now);
		mutable.fill(0);
		expect(fixed(req())).not.toBeNull();
	});
});
