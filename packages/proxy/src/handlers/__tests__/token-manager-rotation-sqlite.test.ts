/**
 * Two rotations in a row while the database takes no writes, then a write
 * that gets through (#827), against a real SQLite row.
 *
 * token-manager-rotation-slot.test.ts covers the same cases with a database
 * double that decides for itself whether a write matched. Here the account
 * row is real, so the `WHERE refresh_token = ?` of the compare-and-set
 * decides, and only the two failed writes are injected.
 */
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseOperations } from "@better-ccflare/database";
import type { Account } from "@better-ccflare/types";
import {
	clearAllPendingRotationsForTests,
	configurePendingRotationPersistence,
	getPendingRotation,
	restorePendingRotations,
} from "../pending-rotation-registry";
import { createPendingRotationStore } from "../pending-rotation-store";
import { getValidAccessToken } from "../token-manager";

const ACCOUNT_ID = "late-write-sqlite";
const CREATED_AT = 101;
const ISSUED_AT = 1_700_000_000_000;

function openDb(): DatabaseOperations {
	// Always this fixture's own SQLite database, even with an ambient
	// DATABASE_URL.
	const ambientUrl = process.env.DATABASE_URL;
	try {
		delete process.env.DATABASE_URL;
		return new DatabaseOperations(":memory:", { cacheSize: -2048 });
	} finally {
		if (ambientUrl === undefined) delete process.env.DATABASE_URL;
		else process.env.DATABASE_URL = ambientUrl;
	}
}

const databaseFull = (): Error =>
	Object.assign(new Error("database or disk is full"), {
		code: "SQLITE_FULL",
	});

/**
 * A token endpoint that rotates on every call and returns the refresh tokens
 * it was sent. The first access token is due for refresh as soon as it is
 * issued, so the next request refreshes again.
 */
function rotatingEndpoint(): string[] {
	const sent: string[] = [];
	global.fetch = mock(async (_url: unknown, init?: RequestInit) => {
		sent.push(
			new URLSearchParams(String(init?.body)).get("refresh_token") ?? "",
		);
		const call = sent.length;
		return new Response(
			JSON.stringify({
				access_token: `access-${call}`,
				refresh_token: `refresh-${call}`,
				expires_in: call === 1 ? 60 : 3600,
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	}) as unknown as typeof fetch;
	return sent;
}

const originalFetch = global.fetch;
let directory: string;
let db: DatabaseOperations;

beforeEach(async () => {
	clearAllPendingRotationsForTests();
	directory = mkdtempSync(join(tmpdir(), "rotation-sqlite-"));
	configurePendingRotationPersistence(openStore());
	db = openDb();
	await db
		.getAdapter()
		.run(
			"INSERT INTO accounts (id, name, provider, refresh_token, access_token, expires_at, created_at, refresh_token_issued_at) VALUES (?, ?, 'codex', 'rt-old', 'at-old', 1, ?, ?)",
			[ACCOUNT_ID, "Late write fixture", CREATED_AT, ISSUED_AT],
		);
});

afterEach(async () => {
	global.fetch = originalFetch;
	clearAllPendingRotationsForTests();
	configurePendingRotationPersistence(null);
	await db.close();
	rmSync(directory, { recursive: true, force: true });
});

function openStore() {
	return createPendingRotationStore({ directory, secret: "sqlite-secret" });
}

function makeContext() {
	return {
		dbOps: db,
		provider: undefined,
		runtime: { port: 8080, clientId: "test-client" },
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) },
	};
}

/** The account as a request reads it from the database. */
async function accountForRequest(): Promise<Account> {
	const account = await db.getAccount(ACCOUNT_ID);
	if (!account) throw new Error("the fixture row is missing");
	return account;
}

/**
 * Fail the first two token writes for lack of space and let every later one
 * reach the row. `beforeFirstRealWrite` runs once, just before the first write
 * that is let through.
 */
function failFirstTwoWrites(
	beforeFirstRealWrite: () => Promise<void> = async () => {},
): { expected: string[] } {
	const write = db.updateAccountTokensIfRefreshTokenMatches.bind(db);
	const expected: string[] = [];
	let writes = 0;
	spyOn(db, "updateAccountTokensIfRefreshTokenMatches").mockImplementation(
		async (...args) => {
			writes += 1;
			if (writes <= 2) throw databaseFull();
			if (writes === 3) await beforeFirstRealWrite();
			expected.push(args[1]);
			return write(...args);
		},
	);
	return { expected };
}

async function nothingLeftWaiting(): Promise<void> {
	expect(getPendingRotation(ACCOUNT_ID, CREATED_AT)).toBeUndefined();
	// The removal from the slot is queued by the refresh, not awaited.
	await new Promise((resolve) => setTimeout(resolve, 0));
	clearAllPendingRotationsForTests();
	configurePendingRotationPersistence(openStore());
	await expect(restorePendingRotations()).resolves.toBe(0);
}

describe("a second rotation made before the first reached a real account row", () => {
	it("is written to the row, which still holds the token the first rotation spent", async () => {
		const ctx = makeContext();
		const writes = failFirstTwoWrites();
		const sentRefreshTokens = rotatingEndpoint();

		await expect(
			getValidAccessToken(await accountForRequest(), ctx as never),
		).resolves.toBe("access-1");
		// No write got through: the row is as it was.
		expect(await accountForRequest()).toMatchObject({
			access_token: "at-old",
			refresh_token: "rt-old",
		});

		await expect(
			getValidAccessToken(await accountForRequest(), ctx as never),
		).resolves.toBe("access-2");

		expect(sentRefreshTokens).toEqual(["rt-old", "refresh-1"]);
		// One write was let through, compared against the token the row holds.
		expect(writes.expected).toEqual(["rt-old"]);
		expect(await accountForRequest()).toMatchObject({
			access_token: "access-2",
			refresh_token: "refresh-2",
			requires_reauth: false,
		});
		await nothingLeftWaiting();
	});

	it("is written to the row when the first rotation was stored there in between", async () => {
		const ctx = makeContext();
		const writes = failFirstTwoWrites(async () => {
			// An earlier request's store of the first rotation lands now.
			await db
				.getAdapter()
				.run(
					"UPDATE accounts SET access_token = 'access-1', refresh_token = 'refresh-1' WHERE id = ?",
					[ACCOUNT_ID],
				);
		});
		const sentRefreshTokens = rotatingEndpoint();

		await expect(
			getValidAccessToken(await accountForRequest(), ctx as never),
		).resolves.toBe("access-1");
		await expect(
			getValidAccessToken(await accountForRequest(), ctx as never),
		).resolves.toBe("access-2");

		expect(sentRefreshTokens).toEqual(["rt-old", "refresh-1"]);
		// The first comparison no longer matches the row, the second does.
		expect(writes.expected).toEqual(["rt-old", "refresh-1"]);
		expect(await accountForRequest()).toMatchObject({
			access_token: "access-2",
			refresh_token: "refresh-2",
		});
		await nothingLeftWaiting();
	});
});
