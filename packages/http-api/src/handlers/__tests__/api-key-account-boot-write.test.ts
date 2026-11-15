import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import type { DatabaseOperations } from "@better-ccflare/database";
import {
	DatabaseFactory,
	ensureSchema,
	runMigrations,
} from "@better-ccflare/database";
import {
	createAnthropicCompatibleAccountAddHandler,
	createMinimaxAccountAddHandler,
	createOpenAIAccountAddHandler,
	createZaiAccountAddHandler,
} from "../accounts";

const TEST_DB_PATH = `${process.env.TMPDIR || "/tmp"}/test-api-key-account-boot-write.db`;

type AddHandler = (req: Request) => Promise<Response>;

/**
 * A start must not need a disk write (#827). The boot migration rewrites any
 * API-key account whose key is mirrored into the token columns, so a handler
 * that stores that legacy shape leaves a write pending for the next start,
 * and a start on a full disk then fails inside the migration transaction.
 */
describe("API-key account creation leaves the next start nothing to write", () => {
	let dbOps: DatabaseOperations;

	function cleanupDbFiles() {
		for (const suffix of ["", "-wal", "-shm"]) {
			try {
				const p = `${TEST_DB_PATH}${suffix}`;
				if (existsSync(p)) unlinkSync(p);
			} catch {
				// best-effort cleanup
			}
		}
	}

	beforeEach(() => {
		cleanupDbFiles();
		DatabaseFactory.initialize(TEST_DB_PATH);
		dbOps = DatabaseFactory.getInstance();
	});

	afterEach(async () => {
		await DatabaseFactory.reset();
		cleanupDbFiles();
	});

	function request(body: Record<string, unknown>): Request {
		return new Request("http://localhost/api/accounts", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}) as unknown as Request;
	}

	const cases: Array<{
		provider: string;
		handler: () => AddHandler;
		body: Record<string, unknown>;
	}> = [
		{
			provider: "zai",
			handler: () => createZaiAccountAddHandler(dbOps),
			body: { name: "shape-zai", apiKey: "key-zai" },
		},
		{
			provider: "minimax",
			handler: () => createMinimaxAccountAddHandler(dbOps),
			body: { name: "shape-minimax", apiKey: "key-minimax" },
		},
		{
			provider: "anthropic-compatible",
			handler: () => createAnthropicCompatibleAccountAddHandler(dbOps),
			body: {
				name: "shape-anthropic-compatible",
				apiKey: "key-anthropic-compatible",
				customEndpoint: "http://127.0.0.1:9",
			},
		},
		{
			provider: "openai-compatible",
			handler: () => createOpenAIAccountAddHandler(dbOps),
			body: {
				name: "shape-openai-compatible",
				apiKey: "key-openai-compatible",
				customEndpoint: "http://127.0.0.1:9/v1",
			},
		},
	];

	for (const testCase of cases) {
		it(`${testCase.provider}: stores the key in api_key only`, async () => {
			const response = await testCase.handler()(request(testCase.body));
			expect(response.status).toBe(200);
			const payload = (await response.json()) as {
				account: { tokenExpiresAt: string | null };
			};
			// A static key never expires; the list endpoint already reports null.
			expect(payload.account.tokenExpiresAt).toBeNull();

			const row = await dbOps.getAdapter().get<{
				api_key: string | null;
				refresh_token: string | null;
				access_token: string | null;
				expires_at: number | null;
			}>(
				"SELECT api_key, refresh_token, access_token, expires_at FROM accounts WHERE name = ?",
				[testCase.body.name as string],
			);
			expect(row).toEqual({
				api_key: testCase.body.apiKey as string,
				refresh_token: null,
				access_token: null,
				expires_at: null,
			});
		});
	}

	it("the boot schema work changes no row after every handler has created an account", async () => {
		for (const testCase of cases) {
			const response = await testCase.handler()(request(testCase.body));
			expect(response.status).toBe(200);
		}
		await DatabaseFactory.reset();

		// What every start runs, on its own connection so total_changes() counts
		// only this pass.
		const db = new Database(TEST_DB_PATH, { readwrite: true, create: false });
		try {
			const schemaVersion = () =>
				(
					db.query("PRAGMA schema_version").get() as {
						schema_version: number;
					}
				).schema_version;
			const before = schemaVersion();
			ensureSchema(db);
			runMigrations(db, TEST_DB_PATH);
			const changes = (
				db.query("SELECT total_changes() AS n").get() as { n: number }
			).n;
			expect({ changes, schemaChanged: schemaVersion() !== before }).toEqual({
				changes: 0,
				schemaChanged: false,
			});
		} finally {
			db.close();
		}
	});
});
