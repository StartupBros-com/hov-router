/**
 * The alert and cache-parity routes moved off /api/insights in 7.0.0 (#1012).
 *
 * A path the API router does not match makes handleRequest return null, and
 * server.ts then hands the request to the inference proxy. So each new path is
 * driven through the router's own dispatch here, and must reach its handler.
 * The old paths' 410 answers are in router-removed-endpoints.test.ts, and the
 * stream and its token in router-stream-token.test.ts.
 *
 * Authentication is disabled here (no API keys) so each request reaches route
 * dispatch, the same as a local install that never created a key.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { APIContext } from "../types";

const scratch = mkdtempSync(join(tmpdir(), "hov-router-alert-routes-"));
process.env.HOV_ROUTER_DB_PATH = join(scratch, "test.db");
process.env.HOV_ROUTER_CONFIG_PATH = join(scratch, "config.json");
process.env.DATABASE_URL = "";
process.env.HOV_ROUTER_PUBLIC_SUBSCRIPTIONS = "";
// Environment values win over saved alert settings.
for (const key of Object.keys(process.env)) {
	if (key.startsWith("ALERT_")) delete process.env[key];
}

const { APIRouter } = await import("../router");
const { Config } = await import("@hov-router/config");

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function setup() {
	const calls: string[] = [];
	const config = new Config(
		join(mkdtempSync(join(scratch, "config-")), "config.json"),
	);
	const context = {
		dbOps: {
			getAdapter: () => ({ queryOffThread: async () => [] }),
			countActiveApiKeys: async () => 0,
			getActiveApiKeys: async () => [],
		},
		config,
		alertService: {
			listAlerts: async (limit: number) => {
				calls.push(`list:${limit}`);
				return [];
			},
			getUnacknowledgedCount: async () => 3,
			acknowledgeAlert: async (id: string) => {
				calls.push(`ack:${id}`);
			},
			acknowledgeAll: async () => {
				calls.push("ack-all");
			},
		},
	} as unknown as APIContext;
	const router = new APIRouter(context);
	const send = async (method: string, path: string, body?: unknown) => {
		const url = new URL(`http://localhost${path}`);
		const response = await router.handleRequest(
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
		if (!response) throw new Error(`${method} ${path} fell through the router`);
		return response;
	};
	return { calls, config, send };
}

describe("alert routes under /api/alerts", () => {
	it("GET /api/alerts lists alerts with the unacknowledged count", async () => {
		const { calls, send } = setup();
		const response = await send("GET", "/api/alerts?limit=7");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			alerts: [],
			unacknowledgedCount: 3,
		});
		expect(calls).toEqual(["list:7"]);
	});

	it("GET /api/alerts/config reads the alert settings", async () => {
		const { config, send } = setup();
		config.setAlertCooldownMinutes(41);
		const response = await send("GET", "/api/alerts/config");
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ cooldownMinutes: 41 });
	});

	it("POST /api/alerts saves the alert settings", async () => {
		const { config, send } = setup();
		const response = await send("POST", "/api/alerts", {
			cooldownMinutes: 42,
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ cooldownMinutes: 42 });
		expect(config.getAlertCooldownMinutes()).toBe(42);
	});

	it("POST /api/alerts/acknowledge-all acknowledges every alert", async () => {
		const { calls, send } = setup();
		const response = await send("POST", "/api/alerts/acknowledge-all");
		expect(response.status).toBe(200);
		expect(calls).toEqual(["ack-all"]);
	});

	it("POST /api/alerts/:id acknowledges that alert, with its id decoded", async () => {
		const { calls, send } = setup();
		const response = await send(
			"POST",
			`/api/alerts/${encodeURIComponent("cache_health:acct/1")}`,
		);
		expect(response.status).toBe(200);
		expect(calls).toEqual(["ack:cache_health:acct/1"]);
	});
});

describe("cache parity under /api/cache-parity", () => {
	it("GET /api/cache-parity reports the parity verdict", async () => {
		const { send } = setup();
		const response = await send("GET", "/api/cache-parity");
		expect(response.status).toBe(200);
		const body = (await response.json()) as Record<string, unknown>;
		expect(body).toHaveProperty("verdict");
		expect(body).toHaveProperty("generatedAt");
	});
});
