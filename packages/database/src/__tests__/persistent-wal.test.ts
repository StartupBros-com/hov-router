import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openExistingDatabase } from "../open-existing-database";
import { keepWalFilesOnClose } from "../persistent-wal";

function size(path: string): number | null {
	return existsSync(path) ? statSync(path).size : null;
}

describe("the WAL side files survive a clean close (#827)", () => {
	let dir: string;
	let dbPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "persistent-wal-"));
		dbPath = join(dir, "test.db");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function writeRows(db: Database): void {
		db.run("CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)");
		const insert = db.prepare("INSERT INTO t (v) VALUES (?)");
		for (let i = 0; i < 200; i++) insert.run("x".repeat(500));
		insert.finalize();
	}

	it("control: SQLite deletes both files when the last connection closes", () => {
		const db = new Database(dbPath, { create: true });
		db.run("PRAGMA journal_mode = WAL");
		writeRows(db);
		db.close(true);
		expect({ wal: size(`${dbPath}-wal`), shm: size(`${dbPath}-shm`) }).toEqual({
			wal: null,
			shm: null,
		});
	});

	it("keeps an allocated index and an empty log, so the next open needs no new blocks", () => {
		const db = new Database(dbPath, { create: true });
		db.run("PRAGMA journal_mode = WAL");
		keepWalFilesOnClose(db);
		writeRows(db);
		db.close(true);
		// An empty log holds no stale frames: restoring a database file over
		// this one cannot replay anything from the old log.
		expect(size(`${dbPath}-wal`)).toBe(0);
		expect(size(`${dbPath}-shm`)).toBe(32768);

		const again = new Database(dbPath, { readwrite: true, create: false });
		try {
			expect(
				(again.query("SELECT COUNT(*) AS n FROM t").get() as { n: number }).n,
			).toBe(200);
			expect(
				(again.query("PRAGMA journal_mode").get() as { journal_mode: string })
					.journal_mode,
			).toBe("wal");
		} finally {
			again.close(true);
		}
	});

	it("a maintenance worker's connection keeps both files when it closes last", () => {
		const first = new Database(dbPath, { create: true });
		first.run("PRAGMA journal_mode = WAL");
		writeRows(first);
		const worker = openExistingDatabase(dbPath);
		worker.run("INSERT INTO t (v) VALUES ('from the worker')");
		// The first connection never asked to keep the files. Its close is not
		// the last, so the decision falls to the worker's connection.
		first.close(true);
		worker.close(true);
		expect({ wal: size(`${dbPath}-wal`), shm: size(`${dbPath}-shm`) }).toEqual({
			wal: 0,
			shm: 32768,
		});
	});

	it("the writer thread's connection keeps both files when it closes last", async () => {
		const seed = new Database(dbPath, { create: true });
		seed.run("PRAGMA journal_mode = WAL");
		writeRows(seed);
		seed.close(true);
		expect(size(`${dbPath}-shm`)).toBeNull();

		const worker = new Worker(
			new URL("../reader-worker.ts", import.meta.url).href,
		);
		const next = (kind: string) =>
			new Promise<Record<string, unknown>>((resolve, reject) => {
				worker.onerror = (event: ErrorEvent) =>
					reject(new Error(event.message ?? "worker error"));
				worker.onmessage = (event: MessageEvent) => {
					if (event.data?.kind === kind) resolve(event.data);
					else reject(new Error(`unexpected ${JSON.stringify(event.data)}`));
				};
			});
		try {
			let reply = next("ready");
			worker.postMessage({
				kind: "open",
				dbPath,
				busyTimeoutMs: 1000,
				access: "write",
			});
			await reply;
			reply = next("result");
			worker.postMessage({
				kind: "write",
				id: 1,
				mode: "run",
				sql: "INSERT INTO t (v) VALUES (?)",
				params: ["from the writer thread"],
			});
			expect((await reply).ok).toBe(true);
			reply = next("retired");
			worker.postMessage({ kind: "retire" });
			await reply;
		} finally {
			worker.terminate();
		}
		expect({ wal: size(`${dbPath}-wal`), shm: size(`${dbPath}-shm`) }).toEqual({
			wal: 0,
			shm: 32768,
		});
	});

	it("the server's own connection leaves both files behind after a clean exit", () => {
		// A child process that collects garbage before closing. Statements the
		// schema work prepared and never finalized keep a closed handle alive
		// until they are collected, and a lingering handle leaves the files in
		// place whatever the setting. A server that has run for a while has
		// collected them, so its close is a real one: without the setting this
		// child ends with both files deleted.
		const script = [
			`import { DatabaseOperations } from ${JSON.stringify(
				join(import.meta.dir, "../database-operations.ts"),
			)};`,
			"const dbOps = new DatabaseOperations(process.env.PERSISTENT_WAL_TEST_DB);",
			"Bun.gc(true); await Bun.sleep(50); Bun.gc(true);",
			"await dbOps.close();",
		].join("\n");
		const child = Bun.spawnSync([process.execPath, "-e", script], {
			env: { ...process.env, PERSISTENT_WAL_TEST_DB: dbPath },
			stdout: "pipe",
			stderr: "pipe",
		});
		expect({
			exitCode: child.exitCode,
			stderr: child.stderr.toString(),
		}).toEqual({ exitCode: 0, stderr: "" });
		expect({ wal: size(`${dbPath}-wal`), shm: size(`${dbPath}-shm`) }).toEqual({
			wal: 0,
			shm: 32768,
		});
	});
});
