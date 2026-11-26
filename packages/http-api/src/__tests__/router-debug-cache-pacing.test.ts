/**
 * GET /api/debug/cache-pacing reports the live pacing cap and its counters.
 *
 * Authentication is disabled here (no API keys) so the request reaches route
 * dispatch, the same as a local install that never created a key.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { APIContext } from "../types";

const scratch = mkdtempSync(join(tmpdir(), "hov-router-debug-cache-pacing-"));
process.env.HOV_ROUTER_DB_PATH = join(scratch, "test.db");
process.env.HOV_ROUTER_CONFIG_PATH = join(scratch, "config.json");
process.env.DATABASE_URL = "";

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

describe("GET /api/debug/cache-pacing", () => {
	it("reports the pacing cap and counters, without the removed Codex settle window", async () => {
		const router = new APIRouter(context());
		const url = new URL("http://localhost/api/debug/cache-pacing");
		const response = await router.handleRequest(
			url,
			new Request(url, { method: "GET" }),
		);
		expect(response?.status).toBe(200);
		const body = (await response?.json()) as Record<string, unknown>;
		// codex_settle_ms was reported as a fixed 0 until 7.0.0.
		expect(Object.keys(body).sort()).toEqual([
			"families",
			"pacing_ms",
			"routes",
		]);
	});
});
