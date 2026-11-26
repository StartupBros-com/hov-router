import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "@hov-router/core";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema } from "../../migrations";
import { RouteProfileConfigRepository } from "../route-profile-config.repository";

describe("RouteProfileConfigRepository (#971)", () => {
	let db: Database;
	let repo: RouteProfileConfigRepository;

	beforeEach(() => {
		db = new Database(":memory:");
		ensureSchema(db);
		repo = new RouteProfileConfigRepository(new BunSqlAdapter(db));
	});

	afterEach(() => db.close());

	it("has no stored lanes on a fresh database", async () => {
		expect(await repo.read()).toBeNull();
		expect(await repo.readRevision()).toBeNull();
	});

	it("creates revision 1 only when nothing is stored yet", async () => {
		expect(
			await repo.save({
				raw: "[]\n",
				expectedRevision: 0,
				source: "import:file",
				now: 1000,
			}),
		).toBe(1);
		expect(await repo.read()).toEqual({
			raw: "[]\n",
			revision: 1,
			updatedAt: 1000,
			source: "import:file",
		});
		// A second create, such as another backend importing at the same time, loses.
		expect(
			await repo.save({
				raw: "[1]",
				expectedRevision: 0,
				source: "import:env",
				now: 2000,
			}),
		).toBeNull();
		expect((await repo.read())?.raw).toBe("[]\n");
	});

	it("replaces the stored text only when the caller saw the current revision", async () => {
		await repo.save({ raw: "a", expectedRevision: 0, source: "api", now: 1 });
		expect(
			await repo.save({ raw: "b", expectedRevision: 1, source: "api", now: 2 }),
		).toBe(2);
		expect(
			await repo.save({ raw: "c", expectedRevision: 1, source: "api", now: 3 }),
		).toBeNull();
		expect(await repo.read()).toEqual({
			raw: "b",
			revision: 2,
			updatedAt: 2,
			source: "api",
		});
		expect(await repo.readRevision()).toBe(2);
	});

	it("keeps the text byte for byte", async () => {
		const raw = '[\n  {"id": "cvp-opus", "logicalModel": "opus"}\n]\n';
		await repo.save({ raw, expectedRevision: 0, source: "api", now: 1 });
		expect((await repo.read())?.raw).toBe(raw);
	});

	it("allows only the one global row", () => {
		expect(() =>
			db.run(
				"INSERT INTO route_profile_config (scope, profiles_json, revision, updated_at, source) VALUES ('other', '[]', 1, 0, 'api')",
			),
		).toThrow();
	});
});
