/**
 * /health and /api/version/check are open without a key, and the router serves
 * only their GET. A null from handleRequest() means "no API route", and
 * apps/server/src/server.ts then hands the request to the upstream proxy, so a
 * keyless request must never come back null once keys exist.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { APIContext } from "../types";

// Set isolation before importing modules that can initialize database singletons.
const scratch = mkdtempSync(join(tmpdir(), "ccflare-exempt-methods-"));
process.env.BETTER_CCFLARE_DB_PATH = join(scratch, "test.db");
process.env.BETTER_CCFLARE_CONFIG_PATH = join(scratch, "config.json");
process.env.DATABASE_URL = "";
const { APIRouter } = await import("../router");

function context(): APIContext {
	return {
		dbOps: {
			getAdapter: () => ({}),
			countActiveApiKeys: async () => 1,
			getActiveApiKeys: async () => [],
		},
		config: {},
	} as unknown as APIContext;
}

describe("exempt paths answer only the method their route serves", () => {
	it("answers a keyless non-GET with 401 instead of falling through to the proxy", async () => {
		const router = new APIRouter(context());
		for (const path of ["/health", "/api/version/check"]) {
			for (const method of [
				"POST",
				"PUT",
				"PATCH",
				"DELETE",
				"HEAD",
				"OPTIONS",
			]) {
				const url = new URL(`http://localhost${path}`);
				const response = await router.handleRequest(
					url,
					new Request(url, { method }),
				);
				expect(response).not.toBeNull();
				expect(response?.status).toBe(401);
			}
		}
	});
});
