import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Config } from "@hov-router/config";
import { DatabaseOperations } from "@hov-router/database";
import {
	createAccountAddHandler,
	createAccountModelMappingsUpdateHandler,
} from "../accounts";

describe("retired account mapping inputs", () => {
	let db: DatabaseOperations;
	beforeEach(() => {
		db = new DatabaseOperations(":memory:", { walMode: false });
	});
	afterEach(async () => {
		await db.close();
	});
	for (const body of [
		{ modelFallbacks: { opus: "old" } },
		{
			customEndpoint: JSON.stringify({
				endpoint: "https://example.invalid",
				modelMappings: { opus: "old" },
			}),
		},
		{ model_mappings: JSON.stringify({ modelMappings: { opus: "old" } }) },
		{ modelMappings: { modelMappings: { opus: "old" } } },
	]) {
		it(`rejects ${JSON.stringify(body)} on create and update`, async () => {
			for (const handler of [
				(req: Request) => createAccountAddHandler(db, {} as Config)(req),
				(req: Request) =>
					createAccountModelMappingsUpdateHandler(db)(req, "missing"),
			]) {
				const response = await handler(
					new Request("http://test/api/accounts", {
						method: "POST",
						body: JSON.stringify(body),
					}),
				);
				expect(response.status).toBe(400);
				expect(await response.text()).toContain("removed in 7.0.0");
			}
		});
	}
});
