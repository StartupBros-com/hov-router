/**
 * The multi-instance guard on a full disk (#827).
 *
 * The startup heartbeat is a write, and a start must not need one: in the
 * default warn mode a heartbeat that cannot be stored costs peer detection,
 * not the start. In refuse mode the operator asked for a hard guarantee that
 * an unrecorded instance cannot give, so the failure stays fatal there.
 */
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../adapters/bun-sql-adapter";
import { ensureSchema } from "../migrations";
import { runStartupGuard, startHeartbeatLoop } from "../multi-instance-guard";

/** A real SQLITE_FULL, raised by SQLite itself against a page ceiling. */
function realSqliteFullError(): Error {
	const db = new Database(":memory:");
	try {
		db.run("CREATE TABLE t (v TEXT)");
		db.run("PRAGMA max_page_count = 1");
		for (let i = 0; i < 100; i++) {
			db.run("INSERT INTO t (v) VALUES (?)", ["x".repeat(4000)]);
		}
	} catch (error) {
		return error as Error;
	} finally {
		db.close();
	}
	throw new Error("the page ceiling never produced an error");
}

type Run = Database["run"];

/**
 * Makes statements containing `fragment` throw `error` until the returned
 * function is called. Everything else reaches the real database.
 */
function failStatements(db: Database, fragment: string, first: Error) {
	const original = db.run.bind(db);
	let failing = true;
	let error = first;
	let attempts = 0;
	(db as unknown as { run: Run }).run = ((sql: unknown, params?: unknown) => {
		if (failing && typeof sql === "string" && sql.includes(fragment)) {
			attempts++;
			throw error;
		}
		return (original as unknown as (s: unknown, p?: unknown) => unknown)(
			sql,
			params,
		);
	}) as Run;
	return {
		attempts: () => attempts,
		/** Fail from now on with this error instead. */
		failWith: (next: Error) => {
			error = next;
			failing = true;
		},
		recover: () => {
			failing = false;
		},
		restore: () => {
			(db as unknown as { run: Run }).run = original as Run;
		},
	};
}

function insertPeer(db: Database, id: string, lastHeartbeat: number): void {
	db.run(
		`INSERT INTO instance_heartbeats
			(instance_id, hostname, pid, started_at, last_heartbeat,
			 node_version, db_dialect)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		[
			id,
			"peer-host",
			4321,
			lastHeartbeat - 5_000,
			lastHeartbeat,
			"v",
			"sqlite",
		],
	);
}

function heartbeatIds(db: Database): string[] {
	return db
		.query<{ instance_id: string }, []>(
			"SELECT instance_id FROM instance_heartbeats ORDER BY instance_id",
		)
		.all()
		.map((row) => row.instance_id);
}

describe("multi-instance guard on a full disk (#827)", () => {
	let db: Database;
	let adapter: BunSqlAdapter;

	beforeEach(() => {
		db = new Database(":memory:");
		ensureSchema(db);
		adapter = new BunSqlAdapter(db);
	});

	it("warn mode starts without its heartbeat and still reports peers", async () => {
		const now = Date.now();
		insertPeer(db, "peer-live", now - 1_000);
		const fault = failStatements(
			db,
			"INSERT INTO instance_heartbeats",
			realSqliteFullError(),
		);
		const warnings: string[] = [];
		try {
			const result = await runStartupGuard(adapter, {
				now,
				mode: "warn",
				log: (msg) => warnings.push(msg),
			});
			expect(fault.attempts()).toBe(1);
			// The scan still ran: a peer that is alive is still reported.
			expect(result.peers.map((peer) => peer.instance_id)).toEqual([
				"peer-live",
			]);
		} finally {
			fault.restore();
		}
		expect(warnings.length).toBe(2);
		expect(warnings[0]).toContain("storage is full");
		expect(warnings[0]).toContain("database or disk is full");
		expect(warnings[1]).toContain("Multi-instance guard");
		// Nothing was stored for this instance.
		expect(heartbeatIds(db)).toEqual(["peer-live"]);
	});

	it("warn mode starts when the purge of a stale row is what fails", async () => {
		const now = Date.now();
		insertPeer(db, "peer-stale", now - 10 * 60_000);
		const fault = failStatements(
			db,
			"DELETE FROM instance_heartbeats",
			realSqliteFullError(),
		);
		const warnings: string[] = [];
		try {
			const result = await runStartupGuard(adapter, {
				now,
				mode: "warn",
				log: (msg) => warnings.push(msg),
			});
			expect(result.peers).toEqual([]);
		} finally {
			fault.restore();
		}
		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain("storage is full");
	});

	it("refuse mode stays fatal: an unrecorded instance is invisible to a peer", async () => {
		const fault = failStatements(
			db,
			"INSERT INTO instance_heartbeats",
			realSqliteFullError(),
		);
		try {
			await expect(
				runStartupGuard(adapter, { mode: "refuse", log: () => {} }),
			).rejects.toMatchObject({ code: "SQLITE_FULL" });
		} finally {
			fault.restore();
		}
	});

	it("warn mode still fails on an error that is not a full disk", async () => {
		const corrupt = Object.assign(
			new Error("database disk image is malformed"),
			{ code: "SQLITE_CORRUPT", errno: 11 },
		);
		const fault = failStatements(
			db,
			"INSERT INTO instance_heartbeats",
			corrupt,
		);
		try {
			await expect(
				runStartupGuard(adapter, { mode: "warn", log: () => {} }),
			).rejects.toMatchObject({ code: "SQLITE_CORRUPT" });
		} finally {
			fault.restore();
		}
	});

	it("the heartbeat loop reports a failing streak once, then the recovery", async () => {
		const fault = failStatements(
			db,
			"INSERT INTO instance_heartbeats",
			realSqliteFullError(),
		);
		const lines: string[] = [];
		const stop = startHeartbeatLoop(adapter, {
			intervalMs: 2,
			log: (msg) => lines.push(msg),
		});
		try {
			const deadline = Date.now() + 2_000;
			while (fault.attempts() < 5 && Date.now() < deadline) {
				await Bun.sleep(2);
			}
			expect(fault.attempts()).toBeGreaterThanOrEqual(5);
			expect(lines.length).toBe(1);
			expect(lines[0]).toContain("heartbeat tick failed");
			expect(lines[0]).toContain("database or disk is full");

			fault.recover();
			while (lines.length < 2 && Date.now() < deadline) await Bun.sleep(2);
			expect(lines.length).toBe(2);
			expect(lines[1]).toContain("heartbeat recorded again");
			expect(heartbeatIds(db).length).toBe(1);
		} finally {
			await stop();
			fault.restore();
		}
	});

	it("the heartbeat loop reports each kind of failure in a streak once", async () => {
		// A full disk and a damaged database are different problems. The second
		// must not go unsaid for ten minutes because the first was reported, and
		// two errors taking turns must not bring back a line every tick.
		const full = realSqliteFullError();
		const corrupt = Object.assign(
			new Error("database disk image is malformed"),
			{ code: "SQLITE_CORRUPT", errno: 11 },
		);
		const fault = failStatements(db, "INSERT INTO instance_heartbeats", full);
		const lines: string[] = [];
		const stop = startHeartbeatLoop(adapter, {
			intervalMs: 2,
			log: (msg) => lines.push(msg),
		});
		const deadline = Date.now() + 5_000;
		const moreAttempts = async (count: number) => {
			const target = fault.attempts() + count;
			while (fault.attempts() < target && Date.now() < deadline) {
				await Bun.sleep(2);
			}
			expect(fault.attempts()).toBeGreaterThanOrEqual(target);
		};
		try {
			await moreAttempts(3);
			expect(lines.length).toBe(1);
			expect(lines[0]).toContain("database or disk is full");

			fault.failWith(corrupt);
			await moreAttempts(3);
			expect(lines.length).toBe(2);
			expect(lines[1]).toContain("heartbeat tick failed");
			expect(lines[1]).toContain("database disk image is malformed");

			for (let turn = 0; turn < 4; turn++) {
				fault.failWith(turn % 2 === 0 ? full : corrupt);
				await moreAttempts(2);
			}
			expect(lines.length).toBe(2);

			fault.recover();
			while (lines.length < 3 && Date.now() < deadline) await Bun.sleep(2);
			expect(lines[2]).toContain("heartbeat recorded again");

			// The next streak starts over: the same kind is said again.
			fault.failWith(full);
			await moreAttempts(3);
			expect(lines.length).toBe(4);
			expect(lines[3]).toContain("heartbeat tick failed (1 in a row)");
		} finally {
			await stop();
			fault.restore();
		}
	});
});
