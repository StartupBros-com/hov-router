import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseFactory } from "../factory";
import { PostgresUrlRefusedError } from "../postgres-refusal";
import {
	armStartReserve,
	START_RESERVE_BYTES,
	startReservePath,
} from "../start-reserve";

// The retry itself (an open that fails for lack of space, then succeeds once
// the reserve is released) is covered in start-reserve.test.ts with an
// injected open. These cover what the factory adds: the right path, and no
// spent reserve when it was not needed.
describe("database factory server start", () => {
	let dir: string;
	let dbPath: string;
	let savedDatabaseUrl: string | undefined;
	let savedReaderWorker: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "hov-router-factory-server-start-"));
		dbPath = join(dir, "test.db");
		savedDatabaseUrl = process.env.DATABASE_URL;
		savedReaderWorker = process.env.HOV_ROUTER_DB_READER_WORKER;
		process.env.HOV_ROUTER_DB_READER_WORKER = "0";
	});

	afterEach(async () => {
		await DatabaseFactory.closeAll();
		if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
		else process.env.DATABASE_URL = savedDatabaseUrl;
		if (savedReaderWorker === undefined) {
			delete process.env.HOV_ROUTER_DB_READER_WORKER;
		} else {
			process.env.HOV_ROUTER_DB_READER_WORKER = savedReaderWorker;
		}
		rmSync(dir, { recursive: true, force: true });
	});

	it("opens the database, registers this instance and keeps the reserve", async () => {
		await armStartReserve(dbPath);
		const released: number[] = [];
		DatabaseFactory.initialize(dbPath);

		const db = await DatabaseFactory.getInstanceForServerStart((bytes) =>
			released.push(bytes),
		);

		expect(db).toBe(DatabaseFactory.getInstance());
		// initializeAsync ran: this instance has a heartbeat row.
		const heartbeats = db
			.getAdapter()
			.getSQLiteDb()
			.query("SELECT COUNT(*) AS n FROM instance_heartbeats")
			.get() as { n: number };
		expect(heartbeats.n).toBe(1);
		expect(released).toEqual([]);
		expect(statSync(startReservePath(dbPath)).size).toBe(START_RESERVE_BYTES);
	});

	it("opens without a reserve on disk and does not create one", async () => {
		DatabaseFactory.initialize(dbPath);

		await DatabaseFactory.getInstanceForServerStart();

		expect(existsSync(startReservePath(dbPath))).toBe(false);
	});

	it("keeps the reserve when the open fails for a reason other than space", async () => {
		await armStartReserve(dbPath);
		process.env.DATABASE_URL = "postgres://user@synthetic.invalid/never";
		DatabaseFactory.initialize(dbPath);

		await expect(
			DatabaseFactory.getInstanceForServerStart(),
		).rejects.toBeInstanceOf(PostgresUrlRefusedError);
		expect(statSync(startReservePath(dbPath)).size).toBe(START_RESERVE_BYTES);
	});
});
