import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { LATEST_OPUS_MODEL } from "@hov-router/core";
import {
	BunSqlAdapter,
	ensureSchema,
	RouteProfileConfigRepository,
} from "@hov-router/database";
import {
	ModelRouteProfileController,
	type ModelRouteProfileStore,
	ModelRouteSessionRegistry,
	setActiveModelRouteProfiles,
} from "@hov-router/proxy";
import {
	createRouteProfilesGetHandler,
	createRouteProfilesPutHandler,
	type RouteProfileAccount,
} from "../route-profiles";

const ACCOUNT_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ACCOUNT_B = "bbbbbbbb-0000-4000-8000-000000000002";
const MISSING = "cccccccc-0000-4000-8000-000000000003";

const lane = (fields: Record<string, unknown> = {}) => ({
	id: "cvp-opus",
	displayName: "CVP Opus",
	accountId: ACCOUNT_A,
	logicalModel: "opus",
	...fields,
});

let db: Database;
let store: ModelRouteProfileStore;
let controller: ModelRouteProfileController;
let accounts: RouteProfileAccount[];

function storeFor(repo: RouteProfileConfigRepository): ModelRouteProfileStore {
	return {
		getModelRouteProfileConfig: () => repo.read(),
		getModelRouteProfileRevision: () => repo.readRevision(),
		saveModelRouteProfileConfig: (input) => repo.save(input),
	};
}

const deps = () => ({
	controller,
	listAccounts: async () => accounts,
});

function put(body: unknown): Promise<Response> {
	return createRouteProfilesPutHandler(deps())(
		new Request("http://localhost/api/route-profiles", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: typeof body === "string" ? body : JSON.stringify(body),
		}),
	);
}

async function get(): Promise<{
	status: number;
	body: {
		success: boolean;
		data: {
			revision: number;
			profiles: unknown[];
			lanes: Array<Record<string, unknown>>;
			status: Record<string, unknown>;
			warnings: string[];
		};
	};
}> {
	const response = await createRouteProfilesGetHandler(deps())();
	return { status: response.status, body: await response.json() };
}

beforeEach(async () => {
	db = new Database(":memory:");
	ensureSchema(db);
	store = storeFor(new RouteProfileConfigRepository(new BunSqlAdapter(db)));
	accounts = [
		{ id: ACCOUNT_A, name: "max-primary" },
		{ id: ACCOUNT_B, name: "max-secondary" },
	];
	controller = await ModelRouteProfileController.start({ store, env: {} });
});

afterEach(() => {
	controller.stopRevisionWatch();
	db.close();
	setActiveModelRouteProfiles(undefined);
});

describe("GET /api/route-profiles (#971)", () => {
	it("reports no lanes and revision 0 before any are stored", async () => {
		const { status, body } = await get();
		expect(status).toBe(200);
		expect(body.data).toEqual({
			revision: 0,
			profiles: [],
			lanes: [],
			status: { source: "none", status: "ok", count: 0 },
			warnings: [],
		});
	});

	it("returns the lanes as written beside their resolved view", async () => {
		expect((await put({ revision: 0, profiles: [lane()] })).status).toBe(200);
		const { body } = await get();
		expect(body.data.revision).toBe(1);
		expect(body.data.profiles).toEqual([lane()]);
		expect(body.data.lanes).toEqual([
			{
				id: "cvp-opus",
				displayName: "CVP Opus",
				modelIds: ["claude-bccf-route-cvp-opus"],
				accountId: ACCOUNT_A,
				accountName: "max-primary",
				// The family name is stored as written and resolved for this view.
				logicalModel: LATEST_OPUS_MODEL,
				exclusiveAccount: false,
			},
		]);
		expect(body.data.status).toMatchObject({
			source: "database",
			revision: 1,
		});
	});

	it("warns about a lane whose account does not exist", async () => {
		await put({ revision: 0, profiles: [lane({ accountId: MISSING })] });
		const { body } = await get();
		expect(body.data.warnings).toEqual([
			`lane cvp-opus: account ${MISSING} matches no account`,
		]);
		expect(body.data.lanes[0]?.accountName).toBeUndefined();
	});

	it("picks up a set another backend stored", async () => {
		await put({ revision: 0, profiles: [lane()] });
		await store.saveModelRouteProfileConfig({
			raw: JSON.stringify([lane({ id: "elsewhere" })]),
			expectedRevision: 1,
			source: "api",
			now: 5,
		});
		const { body } = await get();
		expect(body.data.revision).toBe(2);
		expect(body.data.lanes.map((l) => l.id)).toEqual(["elsewhere"]);
	});
});

describe("PUT /api/route-profiles (#971)", () => {
	it("applies an edit to the live registry and answers with the new state", async () => {
		const registry = new ModelRouteSessionRegistry([]);
		controller.attachRegistry(registry);
		const response = await put({
			revision: 0,
			profiles: [lane({ accountId: ACCOUNT_B })],
		});
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.data.revision).toBe(1);
		expect(body.data.lanes[0].accountName).toBe("max-secondary");
		expect(registry.hasPublicModelId("claude-bccf-route-cvp-opus")).toBe(true);
		expect(registry.isExactProfileRouteForAccount("cvp-opus", ACCOUNT_B)).toBe(
			true,
		);
	});

	it("deletes every lane with an empty list", async () => {
		await put({ revision: 0, profiles: [lane()] });
		const response = await put({ revision: 1, profiles: [] });
		expect(response.status).toBe(200);
		const { body } = await get();
		expect(body.data).toMatchObject({ revision: 2, profiles: [], lanes: [] });
	});

	it("answers a stale revision with 409 and the current revision", async () => {
		await put({ revision: 0, profiles: [lane()] });
		await put({ revision: 1, profiles: [lane({ displayName: "Edited" })] });
		const response = await put({ revision: 1, profiles: [lane()] });
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			error:
				"The route profiles changed (now revision 2); read them again and reapply your edit",
			details: { code: "stale_route_profiles", revision: 2 },
		});
	});

	it("answers an invalid set with 400 and the parser's reason", async () => {
		const response = await put({
			revision: 0,
			profiles: [lane({ logicalModel: "" })],
		});
		expect(response.status).toBe(400);
		const body = await response.json();
		expect(body.details).toEqual({ code: "invalid_route_profiles" });
		expect(body.error).not.toContain("HOV_ROUTER_MODEL_ROUTE_PROFILES_JSON");
		expect(body.error).toContain("logicalModel");
		expect((await get()).body.data.revision).toBe(0);
	});

	it("refuses a body that is not JSON, or not an object", async () => {
		expect((await put("{ nope")).status).toBe(400);
		expect((await put([lane()])).status).toBe(400);
	});

	it("refuses a body over 256 KiB with 413 before parsing it", async () => {
		const response = await put(
			`{"revision":0,"profiles":[],"pad":"${"x".repeat(256 * 1024)}"}`,
		);
		expect(response.status).toBe(413);
	});

	it("answers 503 when the server has no store", async () => {
		controller = await ModelRouteProfileController.start({ env: {} });
		const response = await put({ revision: 0, profiles: [] });
		expect(response.status).toBe(503);
	});
});
