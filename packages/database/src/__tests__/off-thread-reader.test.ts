import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunSqlAdapter } from "../adapters/bun-sql-adapter";
import {
	OffThreadReader,
	type OffThreadReaderOptions,
	OffThreadReaderUnavailableError,
} from "../off-thread-reader";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	mock.restore();
});
const sourceUrl = new URL("../reader-worker.ts", import.meta.url).href;
function realFixture() {
	const dir = mkdtempSync(join(tmpdir(), "ccflare-reader-"));
	const dbPath = join(dir, "test.db");
	const db = new Database(dbPath, { create: true });
	db.exec(
		"PRAGMA journal_mode = WAL; CREATE TABLE sample (i INTEGER, f REAL, t TEXT, n TEXT, b BLOB)",
	);
	db.run("INSERT INTO sample VALUES (?, ?, ?, ?, ?)", [
		42,
		1.25,
		"hello",
		null,
		new Uint8Array([0, 127, 255]),
	]);
	const adapter = new BunSqlAdapter(db);
	const reader = new OffThreadReader({
		dbPath,
		busyTimeoutMs: 100,
		embeddedCode: "",
		sourceUrl,
	});
	adapter.setOffThreadReader(reader);
	cleanups.push(
		() => rmSync(dir, { recursive: true, force: true }),
		() => adapter.close(),
		() => reader.close(),
	);
	return { adapter, reader };
}

class FakeWorker {
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: ErrorEvent) => void) | null = null;
	onmessageerror: ((event: MessageEvent) => void) | null = null;
	messages: Record<string, unknown>[] = [];
	terminated = 0;
	unref = mock(() => {});
	ready = true;
	retireAck = true;
	postMessage(message: Record<string, unknown>) {
		this.messages.push(message);
		if (message.kind === "open" && this.ready)
			queueMicrotask(() => this.emit({ kind: "ready" }));
		if (message.kind === "retire" && this.retireAck)
			queueMicrotask(() => this.emit({ kind: "retired" }));
	}
	emit(data: Record<string, unknown>) {
		this.onmessage?.({ data } as MessageEvent);
	}
	terminate() {
		this.terminated++;
	}
}
function fakeFixture(options: Partial<OffThreadReaderOptions> = {}) {
	const workers: FakeWorker[] = [];
	const warn = mock((_line: string) => {});
	const info = mock((_line: string) => {});
	const revokeObjectURL = mock((_url: string) => {});
	const reader = new OffThreadReader({
		dbPath: "/unused.db",
		busyTimeoutMs: 10,
		embeddedCode: Buffer.from("test worker").toString("base64"),
		sourceUrl,
		workerFactory: () => {
			const worker = new FakeWorker();
			workers.push(worker);
			return worker;
		},
		createObjectURL: () => "blob:test-reader",
		revokeObjectURL,
		warn,
		info,
		...options,
	});
	cleanups.push(() => reader.close());
	return { reader, workers, warn, info, revokeObjectURL };
}
const turns = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A fake whose thread outlives terminate() until exit(), as Bun's does mid-statement. */
class ExitingWorker extends FakeWorker {
	private readonly closeListeners: (() => void)[] = [];
	addEventListener(type: "close", listener: () => void) {
		if (type === "close") this.closeListeners.push(listener);
	}
	exit() {
		for (const listener of this.closeListeners.splice(0)) listener();
	}
}
function exitingFixture(options: Partial<OffThreadReaderOptions> = {}) {
	const workers: ExitingWorker[] = [];
	const fixture = fakeFixture({
		workerFactory: () => {
			const worker = new ExitingWorker();
			workers.push(worker);
			return worker;
		},
		...options,
	});
	return { ...fixture, workers };
}

it("spawns lazily from embedded code, logs readiness once per process, and selects source URLs when empty", async () => {
	const worker = new FakeWorker();
	const workerFactory = mock(
		(_url: string, _options?: WorkerOptions) => worker,
	);
	const createObjectURL = mock((_blob: Blob) => "blob:test-reader");
	const { reader, info } = fakeFixture({ workerFactory, createObjectURL });
	expect(workerFactory).not.toHaveBeenCalled();
	const read = reader.get("SELECT 1", []);
	await turns();
	expect(workerFactory).toHaveBeenCalledWith("blob:test-reader", {
		smol: true,
	});
	expect(await createObjectURL.mock.calls[0][0].text()).toBe("test worker");
	expect(info).toHaveBeenCalledWith(
		"Off-thread reader ready (embedded worker)",
	);
	expect(worker.messages[0]).toEqual({
		kind: "open",
		dbPath: "/unused.db",
		busyTimeoutMs: 10,
	});
	worker.emit({
		kind: "result",
		id: worker.messages[1].id,
		ok: true,
		row: { n: 1 },
		ms: 1,
	});
	expect(await read).toEqual({ n: 1 });
	await reader.close();
	const sourceWorker = new FakeWorker();
	const sourceFactory = mock(
		(_url: string, _options?: WorkerOptions) => sourceWorker,
	);
	const source = fakeFixture({
		embeddedCode: "",
		workerFactory: sourceFactory,
		createObjectURL,
	});
	const next = source.reader.get("SELECT 2", []);
	await turns();
	expect(sourceFactory).toHaveBeenCalledWith(sourceUrl, { smol: true });
	expect(createObjectURL).toHaveBeenCalledTimes(1);
	sourceWorker.emit({
		kind: "result",
		id: sourceWorker.messages[1].id,
		ok: true,
		row: { n: 2 },
		ms: 1,
	});
	expect(await next).toEqual({ n: 2 });
	expect(source.info).not.toHaveBeenCalled();
});

it("spawns its worker under threadName, and a respawn keeps the name", async () => {
	const workerFactory = mock(
		(_url: string, _options?: WorkerOptions) => new FakeWorker(),
	);
	const { reader } = fakeFixture({
		workerFactory,
		threadName: "db-read-inter",
	});
	void reader.get("SELECT 1", []).catch(() => {});
	await turns();
	expect(workerFactory).toHaveBeenCalledWith("blob:test-reader", {
		smol: true,
		name: "db-read-inter",
	});
	const first = workerFactory.mock.results[0]?.value as FakeWorker;
	first.onerror?.({
		message: "worker broke",
		preventDefault() {},
	} as ErrorEvent);
	await turns();
	void reader.get("SELECT 2", []).catch(() => {});
	await turns();
	expect(workerFactory).toHaveBeenCalledTimes(2);
	expect(workerFactory.mock.calls[1]?.[1]).toEqual({
		smol: true,
		name: "db-read-inter",
	});
});

describe("off-thread reader real protocol", () => {
	it("preserves all/get binding types, missing rows, and SQLite errors", async () => {
		const { adapter, reader } = realFixture();
		expect(
			JSON.stringify(
				await reader.all("SELECT * FROM sample WHERE i = ?", [42]),
			),
		).toBe(
			JSON.stringify(
				await adapter.query("SELECT * FROM sample WHERE i = ?", [42]),
			),
		);
		expect(JSON.stringify(await reader.get("SELECT * FROM sample", []))).toBe(
			JSON.stringify(await adapter.get("SELECT * FROM sample")),
		);
		expect(
			await reader.get("SELECT * FROM sample WHERE i = ?", [-1]),
		).toBeNull();
		const error = await adapter
			.query("SELECT missing FROM sample")
			.catch((e) => e);
		const workerError = await reader
			.all("SELECT missing FROM sample", [])
			.catch((e) => e);
		expect(workerError).toBeInstanceOf(Error);
		expect(workerError.message).toBe(error.message);
		expect(workerError.name).toBe(error.name);
		expect(workerError.code).toBe(error.code);
		expect(reader.readsServed).toBe(3);
	});
	it("matches ten concurrent reads and sees a synchronously committed write", async () => {
		const { adapter, reader } = realFixture();
		expect(
			await Promise.all(
				Array.from({ length: 10 }, (_, i) => reader.all("SELECT ? AS n", [i])),
			),
		).toEqual(Array.from({ length: 10 }, (_, n) => [{ n }]));
		const write = adapter.run("INSERT INTO sample(i) VALUES (?)", [99]);
		expect(await reader.get("SELECT i FROM sample WHERE i = ?", [99])).toEqual({
			i: 99,
		});
		await write;
		await reader.close();
		await expect(reader.all("SELECT 1", [])).rejects.toBeInstanceOf(
			OffThreadReaderUnavailableError,
		);
	});
	it("uses a read-only connection with bounded memory and file-backed temp storage", async () => {
		const { reader } = realFixture();
		expect(await reader.get("PRAGMA cache_size", [])).toEqual({
			cache_size: -16384,
		});
		expect(await reader.get("PRAGMA mmap_size", [])).toEqual({ mmap_size: 0 });
		expect(await reader.get("PRAGMA temp_store", [])).toEqual({
			temp_store: 1,
		});
		const error = await reader
			.all("INSERT INTO sample(i) VALUES (1)", [])
			.catch((error) => error);
		expect(error).toMatchObject({ code: "SQLITE_READONLY" });
	});
	it("keeps the event loop free, with a planted blocking negative", async () => {
		const { adapter, reader } = realFixture();
		const sql =
			"WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < ?) SELECT count(*) AS n FROM c";
		let n = 250_000;
		let calibrationMs = 0;
		while (n <= 32_000_000) {
			const start = performance.now();
			await adapter.query(sql, [n]);
			calibrationMs = performance.now() - start;
			if (calibrationMs >= 600) break;
			n *= 2;
		}
		expect(calibrationMs).toBeGreaterThanOrEqual(600);
		expect(n).toBeLessThanOrEqual(32_000_000);
		async function lag(read: () => Promise<unknown>) {
			let last = performance.now();
			let maxLag = 0;
			const timer = setInterval(() => {
				const now = performance.now();
				maxLag = Math.max(maxLag, now - last - 10);
				last = now;
			}, 10);
			try {
				await new Promise((resolve) => setTimeout(resolve, 30));
				await read();
				await new Promise((resolve) => setTimeout(resolve, 30));
			} finally {
				clearInterval(timer);
			}
			return maxLag;
		}
		const negativeLag = await lag(() => adapter.query(sql, [n]));
		await reader.get("SELECT 1", []);
		const served = reader.readsServed;
		const workerLag = await lag(() => adapter.queryOffThread(sql, [n]));
		console.info(JSON.stringify({ n, calibrationMs, negativeLag, workerLag }));
		expect(negativeLag).toBeGreaterThanOrEqual(500);
		expect(workerLag).toBeLessThan(200);
		expect(workerLag).toBeLessThan(negativeLag / 3);
		expect(reader.readsServed).toBe(served + 1);
	}, 60_000);
});

describe("off-thread reader fault lifecycle", () => {
	it("closes during open without a later readiness fault", async () => {
		const worker = new FakeWorker();
		worker.ready = false;
		const { reader, warn } = fakeFixture({
			workerFactory: () => worker,
			readyTimeoutMs: 20,
		});
		const read = reader.all("SELECT 1", []).catch((error) => error);
		await reader.close();
		expect(await read).toBeInstanceOf(OffThreadReaderUnavailableError);
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(warn).not.toHaveBeenCalled();
		expect(worker.terminated).toBe(1);
	});
	it("bounds retirement when a stuck worker cannot acknowledge", async () => {
		const worker = new FakeWorker();
		worker.retireAck = false;
		const { reader, revokeObjectURL } = fakeFixture({
			workerFactory: () => worker,
		});
		const read = reader.all("SELECT 1", []).catch((error) => error);
		await turns();
		const start = performance.now();
		await reader.close();
		expect(performance.now() - start).toBeGreaterThanOrEqual(900);
		expect(await read).toBeInstanceOf(OffThreadReaderUnavailableError);
		expect(worker.terminated).toBe(1);
		expect(revokeObjectURL).toHaveBeenCalledTimes(1);
	});
	it("warns on spawn failure, revokes its URL, and pauses after the spawn budget", async () => {
		const workerFactory = mock(() => {
			throw new Error("spawn failed");
		});
		const { reader, warn, revokeObjectURL } = fakeFixture({
			workerFactory,
			maxSpawns: 2,
		});
		await expect(reader.all("SELECT 1", [])).rejects.toBeInstanceOf(
			OffThreadReaderUnavailableError,
		);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0][0]).toContain("spawn failed");
		await expect(reader.all("SELECT 1", [])).rejects.toBeInstanceOf(
			OffThreadReaderUnavailableError,
		);
		await expect(reader.all("SELECT 1", [])).rejects.toBeInstanceOf(
			OffThreadReaderUnavailableError,
		);
		expect(workerFactory).toHaveBeenCalledTimes(2);
		expect(revokeObjectURL).toHaveBeenCalledTimes(2);
		expect(
			warn.mock.calls.filter(([line]) =>
				line.includes(
					"off-thread reader spawn budget spent; its reads fail for 60s, then it respawns",
				),
			),
		).toHaveLength(1);
		expect(
			warn.mock.calls.filter(([line]) => line.includes("main-thread")),
		).toHaveLength(0);
	});
	it.each([
		"error",
		"messageerror",
	])("fails the running read on %s, re-posts queued reads, and respawns", async (kind) => {
		const { reader, workers } = fakeFixture();
		const running = reader.all("SELECT 1", []).catch((e) => e);
		const queued = reader.get("SELECT 2", []);
		await turns();
		// The worker holds one read at a time; the second waits on this thread.
		expect(
			workers[0].messages.filter((m) => m.kind === "read").map((m) => m.sql),
		).toEqual(["SELECT 1"]);
		if (kind === "error")
			workers[0].onerror?.({
				message: "worker broke",
				preventDefault() {},
			} as ErrorEvent);
		else workers[0].onmessageerror?.({ data: "bad message" } as MessageEvent);
		// The head may have been running when the worker broke, so it fails as
		// unavailable. The read behind it never started.
		expect(await running).toBeInstanceOf(OffThreadReaderUnavailableError);
		await turns();
		expect(workers).toHaveLength(2);
		const reposted = workers[1].messages.find((m) => m.kind === "read");
		expect(reposted).toMatchObject({ mode: "get", sql: "SELECT 2" });
		workers[1].emit({
			kind: "result",
			id: reposted?.id,
			ok: true,
			row: { n: 2 },
			ms: 1,
		});
		expect(await queued).toEqual({ n: 2 });
		const next = reader.get("SELECT 3", []);
		await turns();
		const message = workers[1].messages.filter((m) => m.kind === "read").at(-1);
		expect(message?.sql).toBe("SELECT 3");
		workers[1].emit({
			kind: "result",
			id: message?.id,
			ok: true,
			row: { n: 3 },
			ms: 1,
		});
		expect(await next).toEqual({ n: 3 });
		expect(workers[0].terminated).toBe(1);
		expect(workers[1].unref).toHaveBeenCalledTimes(1);
	});
	it("times out only the hung read with a plain error and runs the reads waiting behind it on a fresh worker", async () => {
		const { reader, workers, warn } = fakeFixture({ readTimeoutMs: 200 });
		const first = reader.all("SELECT 'secret'", []).catch((e) => e);
		// Queued 100 ms in, so they have waited half their timeout when the hung
		// read times out.
		await new Promise((resolve) => setTimeout(resolve, 100));
		const sibling = reader.all("SELECT 2", []);
		const last = reader.get("SELECT 3", []);
		const error = await first;
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(OffThreadReaderUnavailableError);
		expect(error.message).toBe(
			"off-thread read timed out after 200ms: SELECT ?",
		);
		await turns();
		expect(workers[0].terminated).toBe(1);
		expect(workers).toHaveLength(2);
		const reads = () => workers[1].messages.filter((m) => m.kind === "read");
		expect(reads().map((m) => [m.mode, m.sql])).toEqual([["all", "SELECT 2"]]);
		workers[1].emit({
			kind: "result",
			id: reads()[0].id,
			ok: true,
			rows: [{ n: 2 }],
			ms: 1,
		});
		expect(await sibling).toEqual([{ n: 2 }]);
		expect(reads().map((m) => [m.mode, m.sql])).toEqual([
			["all", "SELECT 2"],
			["get", "SELECT 3"],
		]);
		workers[1].emit({
			kind: "result",
			id: reads()[1].id,
			ok: true,
			row: { n: 3 },
			ms: 1,
		});
		expect(await last).toEqual({ n: 3 });
		expect(warn.mock.calls.map(([line]) => line)).toEqual([
			"off-thread reader read timeout: off-thread read timed out after 200ms: SELECT ?",
		]);
	});
	it("gives a read its whole timeout to run once it reaches the worker, however long it waited", async () => {
		const { reader, workers, warn } = fakeFixture({ readTimeoutMs: 300 });
		const first = reader.all("SELECT 1", []);
		const queued = reader.all("SELECT 2", []);
		await turns();
		const [head] = workers[0].messages.filter((m) => m.kind === "read");
		await new Promise((resolve) => setTimeout(resolve, 200));
		workers[0].emit({
			kind: "result",
			id: head.id,
			ok: true,
			rows: [{ n: 1 }],
			ms: 1,
		});
		expect(await first).toEqual([{ n: 1 }]);
		const behind = workers[0].messages.filter((m) => m.kind === "read")[1];
		expect(behind?.sql).toBe("SELECT 2");
		// 400 ms after it was asked for, 200 ms after it reached the worker: one
		// timer started when the read was asked for would have fired at 300 ms.
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(warn).not.toHaveBeenCalled();
		expect(workers[0].terminated).toBe(0);
		workers[0].emit({
			kind: "result",
			id: behind.id,
			ok: true,
			rows: [{ n: 2 }],
			ms: 1,
		});
		expect(await queued).toEqual([{ n: 2 }]);
	});
	it("fails a read that waits its whole timeout with a plain error, without faulting the worker", async () => {
		const { reader, workers, warn } = fakeFixture({ readTimeoutMs: 200 });
		const first = reader.all("SELECT 1", []);
		const second = reader.all("SELECT 2", []);
		const third = reader.all("SELECT 'private'", []).catch((e) => e);
		await turns();
		const reads = () => workers[0].messages.filter((m) => m.kind === "read");
		await new Promise((resolve) => setTimeout(resolve, 100));
		workers[0].emit({
			kind: "result",
			id: reads()[0].id,
			ok: true,
			rows: [{ n: 1 }],
			ms: 1,
		});
		expect(await first).toEqual([{ n: 1 }]);
		// The second read is running and within its own timeout; the third has
		// waited 200 ms behind both and gives up.
		const shed = await third;
		expect(shed).toBeInstanceOf(Error);
		expect(shed).not.toBeInstanceOf(OffThreadReaderUnavailableError);
		expect(shed.message).toBe(
			"off-thread reader busy: read waited 200ms: SELECT ?",
		);
		expect(warn.mock.calls.map(([line]) => line)).toEqual([
			"off-thread reader busy: read waited 200ms: SELECT ?",
		]);
		expect(workers[0].terminated).toBe(0);
		workers[0].emit({
			kind: "result",
			id: reads()[1].id,
			ok: true,
			rows: [{ n: 2 }],
			ms: 1,
		});
		expect(await second).toEqual([{ n: 2 }]);
		expect(reads().map((m) => m.sql)).toEqual(["SELECT 1", "SELECT 2"]);
	});
	it.each([
		"open-failed",
		"spawn-failed",
	])("keeps waiting reads through a replacement worker that %s", async (kind) => {
		const workers: FakeWorker[] = [];
		let spawns = 0;
		const { reader, warn } = fakeFixture({
			workerFactory: () => {
				spawns++;
				if (spawns === 2 && kind === "spawn-failed")
					throw new Error("spawn failed");
				const worker = new FakeWorker();
				if (spawns === 2) worker.ready = false;
				workers.push(worker);
				return worker;
			},
		});
		const running = reader.all("SELECT 1", []).catch((e) => e);
		const waiting = reader.get("SELECT 2", []);
		await turns();
		workers[0].onerror?.({
			message: "worker broke",
			preventDefault() {},
		} as ErrorEvent);
		expect(await running).toBeInstanceOf(OffThreadReaderUnavailableError);
		await turns();
		if (kind === "open-failed") {
			expect(workers).toHaveLength(2);
			workers[1].emit({ kind: "open-failed", error: "cannot open database" });
			await turns();
			expect(workers[1].terminated).toBe(1);
		}
		const last = workers.at(-1);
		const message = last?.messages.find((m) => m.kind === "read");
		expect(message).toMatchObject({ mode: "get", sql: "SELECT 2" });
		last?.emit({
			kind: "result",
			id: message?.id,
			ok: true,
			row: { n: 2 },
			ms: 1,
		});
		expect(await waiting).toEqual({ n: 2 });
		expect(warn).toHaveBeenCalledTimes(2);
	});
	it("fails waiting reads as unavailable once the spawn budget is spent", async () => {
		const { reader, workers } = fakeFixture({ maxSpawns: 1 });
		const running = reader.all("SELECT 1", []).catch((e) => e);
		const waiting = reader.all("SELECT 2", []).catch((e) => e);
		await turns();
		workers[0].onerror?.({
			message: "worker broke",
			preventDefault() {},
		} as ErrorEvent);
		expect(await running).toBeInstanceOf(OffThreadReaderUnavailableError);
		expect(await waiting).toBeInstanceOf(OffThreadReaderUnavailableError);
		expect(workers).toHaveLength(1);
	});
	it("fails only a read the worker could not accept, without faulting the worker", async () => {
		class PickyWorker extends FakeWorker {
			override postMessage(message: Record<string, unknown>) {
				if (message.sql === "SELECT boom") throw new Error("could not clone");
				super.postMessage(message);
			}
		}
		const worker = new PickyWorker();
		const { reader, warn } = fakeFixture({ workerFactory: () => worker });
		const running = reader.all("SELECT 1", []);
		const boom = reader.all("SELECT boom", []).catch((e) => e);
		const after = reader.all("SELECT 3", []);
		await turns();
		const reads = () => worker.messages.filter((m) => m.kind === "read");
		worker.emit({
			kind: "result",
			id: reads()[0].id,
			ok: true,
			rows: [{ n: 1 }],
			ms: 1,
		});
		expect(await running).toEqual([{ n: 1 }]);
		expect(await boom).toBeInstanceOf(OffThreadReaderUnavailableError);
		expect(worker.terminated).toBe(0);
		expect(warn).not.toHaveBeenCalled();
		// The read behind the one that failed still reaches the worker.
		expect(reads().map((m) => m.sql)).toEqual(["SELECT 1", "SELECT 3"]);
		worker.emit({
			kind: "result",
			id: reads()[1].id,
			ok: true,
			rows: [{ n: 3 }],
			ms: 1,
		});
		expect(await after).toEqual([{ n: 3 }]);
	});
	it("names its lane in readiness and slow-statement lines", async () => {
		const { reader, workers, warn, info } = fakeFixture({
			label: "interactive reader",
		});
		const read = reader.all("SELECT 'x'", []);
		await turns();
		expect(info).toHaveBeenCalledWith(
			"Off-thread interactive reader ready (embedded worker)",
		);
		const message = workers[0].messages.find((m) => m.kind === "read");
		workers[0].emit({
			kind: "result",
			id: message?.id,
			ok: true,
			rows: [{ x: 1 }],
			ms: 300,
		});
		expect(await read).toEqual([{ x: 1 }]);
		expect(warn).toHaveBeenCalledWith(
			"Slow off-thread SQL: 300ms all SELECT ? (interactive reader)",
		);
	});
	it.each([
		"open-failed",
		"ready-timeout",
	])("rejects unavailable on %s", async (kind) => {
		const worker = new FakeWorker();
		worker.ready = false;
		const { reader, warn } = fakeFixture({
			workerFactory: () => worker,
			readyTimeoutMs: 20,
		});
		const read = reader.all("SELECT 1", []).catch((e) => e);
		if (kind === "open-failed")
			worker.emit({ kind: "open-failed", error: "cannot open database" });
		expect(await read).toBeInstanceOf(OffThreadReaderUnavailableError);
		expect(worker.terminated).toBe(1);
		expect(warn).toHaveBeenCalledTimes(1);
	});
	it("passes SQLITE_BUSY back with its code without terminating the worker", async () => {
		const { reader, workers, warn } = fakeFixture();
		const read = reader.all("SELECT 1", []).catch((e) => e);
		await turns();
		const message = workers[0].messages.find((m) => m.kind === "read");
		workers[0].emit({
			kind: "result",
			id: message?.id,
			ok: false,
			error: {
				message: "database is locked",
				name: "SQLiteError",
				code: "SQLITE_BUSY",
			},
			ms: 10,
		});
		const error = await read;
		expect(error).not.toBeInstanceOf(OffThreadReaderUnavailableError);
		expect(error.message).toBe("database is locked");
		expect(error.code).toBe("SQLITE_BUSY");
		expect(workers[0].terminated).toBe(0);
		expect(warn).not.toHaveBeenCalled();
	});
	it("logs slow fingerprints, serves successful reads, and retires idempotently", async () => {
		const { reader, workers, warn, revokeObjectURL } = fakeFixture();
		const read = reader.all("SELECT 'private'", []);
		await turns();
		const message = workers[0].messages.find((m) => m.kind === "read");
		workers[0].emit({
			kind: "result",
			id: message?.id,
			ok: true,
			rows: [{ n: 1 }],
			ms: 300,
		});
		expect(await read).toEqual([{ n: 1 }]);
		expect(reader.readsServed).toBe(1);
		expect(warn).toHaveBeenCalledWith(
			"Slow off-thread SQL: 300ms all SELECT ?",
		);
		const pending = reader.get("SELECT 2", []).catch((e) => e);
		const waiting = reader.get("SELECT 3", []).catch((e) => e);
		await turns();
		const close = reader.close();
		expect(reader.close()).toBe(close);
		expect(await pending).toBeInstanceOf(OffThreadReaderUnavailableError);
		expect(await waiting).toBeInstanceOf(OffThreadReaderUnavailableError);
		await close;
		expect(workers[0].terminated).toBe(1);
		expect(revokeObjectURL).toHaveBeenCalledTimes(1);
	});
});

describe("adapter off-thread reads", () => {
	it("propagates read timeouts without rerunning the hung SQL on the main thread", async () => {
		const { adapter } = realFixture();
		const { reader } = fakeFixture({ readTimeoutMs: 20 });
		adapter.setOffThreadReader(reader);
		const query = spyOn(adapter, "query");
		const error = await adapter
			.queryOffThread("SELECT 'private'")
			.catch((error) => error);
		expect(error.message).toBe(
			"off-thread read timed out after 20ms: SELECT ?",
		);
		expect(error).not.toBeInstanceOf(OffThreadReaderUnavailableError);
		expect(query).not.toHaveBeenCalled();
	});
	it("runs reads waiting behind a timed-out read on a fresh worker, not the main thread", async () => {
		const { adapter } = realFixture();
		const { reader, workers } = fakeFixture({ readTimeoutMs: 200 });
		adapter.setOffThreadReader(reader);
		const query = spyOn(adapter, "query");
		const hung = adapter.queryOffThread("SELECT 'hung'").catch((e) => e);
		await new Promise((resolve) => setTimeout(resolve, 100));
		const queued = adapter.queryOffThread("SELECT 2 AS n");
		expect((await hung).message).toBe(
			"off-thread read timed out after 200ms: SELECT ?",
		);
		await turns();
		const message = workers[1]?.messages.find((m) => m.kind === "read");
		expect(message?.sql).toBe("SELECT 2 AS n");
		workers[1].emit({
			kind: "result",
			id: message?.id,
			ok: true,
			rows: [{ n: 2 }],
			ms: 1,
		});
		expect(await queued).toEqual([{ n: 2 }]);
		expect(query).not.toHaveBeenCalled();
	});
	it("serves interactive reads on their own reader while the bulk reader is busy", async () => {
		const { adapter } = realFixture();
		const interactive = fakeFixture();
		const bulk = fakeFixture();
		// Interactive first: an adapter that ignored lanes would let the bulk
		// reader replace it.
		adapter.setOffThreadReader(interactive.reader, "interactive");
		adapter.setOffThreadReader(bulk.reader);
		const query = spyOn(adapter, "query");
		const scan = adapter.queryOffThread("SELECT 'scan'");
		const quick = adapter.getOffThread("SELECT 1 AS n", [], "interactive");
		await turns();
		const message = interactive.workers[0]?.messages.find(
			(m) => m.kind === "read",
		);
		expect(message).toMatchObject({ mode: "get", sql: "SELECT 1 AS n" });
		interactive.workers[0].emit({
			kind: "result",
			id: message?.id,
			ok: true,
			row: { n: 1 },
			ms: 1,
		});
		expect(await quick).toEqual({ n: 1 });
		// Without an interactive reader, interactive reads share the bulk one.
		adapter.setOffThreadReader(undefined, "interactive");
		const shared = adapter.queryOffThread("SELECT 2 AS n", [], "interactive");
		await turns();
		const reads = () =>
			bulk.workers[0].messages.filter((m) => m.kind === "read");
		expect(reads().map((m) => m.sql)).toEqual(["SELECT 'scan'"]);
		bulk.workers[0].emit({
			kind: "result",
			id: reads()[0].id,
			ok: true,
			rows: [{ scan: 1 }],
			ms: 1,
		});
		expect(await scan).toEqual([{ scan: 1 }]);
		expect(reads().map((m) => m.sql)).toEqual([
			"SELECT 'scan'",
			"SELECT 2 AS n",
		]);
		bulk.workers[0].emit({
			kind: "result",
			id: reads()[1].id,
			ok: true,
			rows: [{ n: 2 }],
			ms: 1,
		});
		expect(await shared).toEqual([{ n: 2 }]);
		expect(query).not.toHaveBeenCalled();
	});
	it("reads on the main thread only without a reader, and passes reader errors through", async () => {
		const { adapter } = realFixture();
		adapter.setOffThreadReader(undefined);
		const query = spyOn(adapter, "query");
		const get = spyOn(adapter, "get");
		expect(await adapter.queryOffThread("SELECT ? AS n", [1])).toEqual([
			{ n: 1 },
		]);
		expect(await adapter.getOffThread("SELECT ? AS n", [2])).toEqual({ n: 2 });
		expect(query).toHaveBeenCalledTimes(1);
		expect(get).toHaveBeenCalledTimes(1);
		const unavailable = new OffThreadReaderUnavailableError("unavailable");
		adapter.setOffThreadReader({
			all: async () => {
				throw unavailable;
			},
			get: async () => {
				throw unavailable;
			},
		});
		await expect(adapter.queryOffThread("SELECT ? AS n", [3])).rejects.toBe(
			unavailable,
		);
		await expect(adapter.getOffThread("SELECT ? AS n", [4])).rejects.toBe(
			unavailable,
		);
		const error = Object.assign(new Error("SQL broke"), {
			code: "SQLITE_ERROR",
		});
		adapter.setOffThreadReader({
			all: async () => {
				throw error;
			},
			get: async () => {
				throw error;
			},
		});
		await expect(adapter.queryOffThread("SELECT 9")).rejects.toBe(error);
		await expect(adapter.getOffThread("SELECT 9")).rejects.toBe(error);
		expect(query).toHaveBeenCalledTimes(1);
		expect(get).toHaveBeenCalledTimes(1);
	});
});

// #921: a heavy read moved onto the main connection blocks the thread that also
// relays live streams, and the guard cuts them. Reads run on a worker or fail.
describe("off-thread reads never move to the main thread (#921)", () => {
	// Long enough to pass any read timeout below on this machine, short enough
	// that a terminated worker's thread finishes it soon after.
	const SLOW =
		"WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 10000000) SELECT count(*) AS n FROM c";

	it("keeps a real reader serving through repeated read timeouts", async () => {
		const { adapter } = realFixture();
		const warn = mock((_line: string) => {});
		const reader = new OffThreadReader({
			dbPath: adapter.getSQLiteDb().filename,
			busyTimeoutMs: 100,
			embeddedCode: "",
			sourceUrl,
			readTimeoutMs: 150,
			maxSpawns: 3,
			// This case is about the spawn budget. The cap on terminated workers
			// that are still running has its own case below.
			maxOrphans: 3,
			warn,
		});
		cleanups.push(() => reader.close());
		adapter.setOffThreadReader(reader);
		const query = spyOn(adapter, "query");
		const get = spyOn(adapter, "get");
		// Three timeouts used to spend the whole budget and switch every later
		// read onto the main connection for the rest of the process.
		for (let round = 0; round < 3; round++) {
			const slow = await adapter.queryOffThread(SLOW).catch((e) => e);
			expect(slow.message).toStartWith("off-thread read timed out after 150ms");
			expect(await adapter.queryOffThread("SELECT i FROM sample")).toEqual([
				{ i: 42 },
			]);
		}
		expect(await adapter.getOffThread("SELECT t FROM sample")).toEqual({
			t: "hello",
		});
		expect(query).not.toHaveBeenCalled();
		expect(get).not.toHaveBeenCalled();
		expect(
			warn.mock.calls.filter(([line]) => line.includes("spawn budget spent")),
		).toHaveLength(0);
	}, 30_000);

	it("fails reads while a spent budget cools down, then respawns", async () => {
		let clock = 1_000;
		const { adapter } = realFixture();
		const { reader, workers, warn } = fakeFixture({
			maxSpawns: 1,
			respawnCooldownMs: 60_000,
			now: () => clock,
		});
		adapter.setOffThreadReader(reader);
		const query = spyOn(adapter, "query");
		const first = adapter.queryOffThread("SELECT 1").catch((e) => e);
		await turns();
		workers[0].onerror?.({
			message: "worker broke",
			preventDefault() {},
		} as ErrorEvent);
		expect(await first).toBeInstanceOf(OffThreadReaderUnavailableError);
		const during = await adapter.queryOffThread("SELECT 2").catch((e) => e);
		expect(during).toBeInstanceOf(OffThreadReaderUnavailableError);
		expect(workers).toHaveLength(1);
		expect(
			warn.mock.calls.filter(([line]) =>
				line.includes(
					"off-thread reader spawn budget spent; its reads fail for 60s, then it respawns",
				),
			),
		).toHaveLength(1);
		clock += 60_000;
		const later = adapter.queryOffThread("SELECT 3 AS n");
		await turns();
		expect(workers).toHaveLength(2);
		const message = workers[1].messages.find((m) => m.kind === "read");
		workers[1].emit({
			kind: "result",
			id: message?.id,
			ok: true,
			rows: [{ n: 3 }],
			ms: 1,
		});
		expect(await later).toEqual([{ n: 3 }]);
		expect(query).not.toHaveBeenCalled();
	});

	it("waits out SQLITE_BUSY on the reader", async () => {
		const { adapter } = realFixture();
		const { reader, workers } = fakeFixture();
		adapter.setOffThreadReader(reader);
		const query = spyOn(adapter, "query");
		const read = adapter.queryOffThread("SELECT 4 AS n");
		await turns();
		const reads = () => workers[0].messages.filter((m) => m.kind === "read");
		workers[0].emit({
			kind: "result",
			id: reads()[0]?.id,
			ok: false,
			error: {
				message: "database is locked",
				name: "SQLiteError",
				code: "SQLITE_BUSY",
			},
			ms: 10,
		});
		await new Promise((resolve) => setTimeout(resolve, 600));
		expect(reads()[1]?.sql).toBe("SELECT 4 AS n");
		workers[0].emit({
			kind: "result",
			id: reads()[1]?.id,
			ok: true,
			rows: [{ n: 4 }],
			ms: 1,
		});
		expect(await read).toEqual([{ n: 4 }]);
		expect(query).not.toHaveBeenCalled();
		expect(workers[0].terminated).toBe(0);
	});
});

describe("a terminated worker keeps its thread until its statement returns", () => {
	const timedOut = (error: Error) =>
		expect(error.message).toStartWith("off-thread read timed out after");

	it("holds a replacement while more than maxOrphans terminated workers still run, and resumes on an exit", async () => {
		const { reader, workers, warn } = exitingFixture({ readTimeoutMs: 100 });
		timedOut(await reader.all("SELECT 'a'").catch((e) => e));
		expect(workers[0].terminated).toBe(1);
		// One terminated worker may run beside a live one.
		const second = reader.all("SELECT 'b'").catch((e) => e);
		await turns();
		expect(workers).toHaveLength(2);
		timedOut(await second);
		// Two still run: the next read waits instead of starting a third thread.
		const held = reader.get("SELECT 3 AS n");
		await turns();
		expect(workers).toHaveLength(2);
		expect(
			warn.mock.calls.filter(([line]) =>
				line.startsWith(
					"off-thread reader holds new workers: 2 terminated workers are still running",
				),
			),
		).toHaveLength(1);
		workers[0].exit();
		await turns();
		expect(workers).toHaveLength(3);
		const read = workers[2].messages.find((m) => m.kind === "read");
		expect(read?.sql).toBe("SELECT 3 AS n");
		workers[2].emit({
			kind: "result",
			id: read?.id,
			ok: true,
			row: { n: 3 },
			ms: 1,
		});
		expect(await held).toEqual({ n: 3 });
		// A second episode warns again: the third worker times out while the
		// second still runs, so two are running once more.
		const again = reader.all("SELECT 'd'").catch((e) => e);
		await turns();
		expect(workers).toHaveLength(3);
		timedOut(await again);
		const heldAgain = reader.get("SELECT 5 AS n").catch((e) => e);
		await turns();
		expect(workers).toHaveLength(3);
		expect(
			warn.mock.calls.filter(([line]) =>
				line.startsWith("off-thread reader holds new workers:"),
			),
		).toHaveLength(2);
		await heldAgain;
		expect(
			warn.mock.calls.filter(([line]) =>
				/^off-thread reader terminated worker exited after \d+ms$/.test(line),
			),
		).toHaveLength(1);
	});

	it("sheds a read held behind terminated workers at its own timeout", async () => {
		const { reader, workers } = exitingFixture({ readTimeoutMs: 100 });
		timedOut(await reader.all("SELECT 'a'").catch((e) => e));
		timedOut(await reader.all("SELECT 'b'").catch((e) => e));
		const held = await reader.all("SELECT 'c'").catch((e) => e);
		expect(held).not.toBeInstanceOf(OffThreadReaderUnavailableError);
		expect(held.message).toStartWith(
			"off-thread reader busy: read waited 100ms",
		);
		expect(workers).toHaveLength(2);
	});

	it("stops counting a terminated worker that never exits after ten read timeouts", async () => {
		const { reader, workers, warn } = exitingFixture({ readTimeoutMs: 20 });
		timedOut(await reader.all("SELECT 'a'").catch((e) => e));
		timedOut(await reader.all("SELECT 'b'").catch((e) => e));
		await sleep(260);
		expect(
			warn.mock.calls.filter(([line]) =>
				/^off-thread reader terminated worker still running after \d+ms; no longer counted against maxOrphans$/.test(
					line,
				),
			),
		).toHaveLength(2);
		const later = reader.get("SELECT 4 AS n");
		await turns();
		expect(workers).toHaveLength(3);
		const read = workers[2].messages.find((m) => m.kind === "read");
		workers[2].emit({
			kind: "result",
			id: read?.id,
			ok: true,
			row: { n: 4 },
			ms: 1,
		});
		expect(await later).toEqual({ n: 4 });
	});

	it("does not count the worker it retires at close", async () => {
		const { reader, workers, warn } = exitingFixture();
		const read = reader.get("SELECT 1 AS n");
		await turns();
		const message = workers[0].messages.find((m) => m.kind === "read");
		workers[0].emit({
			kind: "result",
			id: message?.id,
			ok: true,
			row: { n: 1 },
			ms: 1,
		});
		expect(await read).toEqual({ n: 1 });
		await reader.close();
		workers[0].exit();
		expect(
			warn.mock.calls.filter(([line]) => line.includes("terminated worker")),
		).toHaveLength(0);
	});

	let realLane = 0;
	it("keeps a real lane to two threads through repeated read timeouts", async () => {
		if (!existsSync("/proc/self/task")) return;
		const SLOW =
			"WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 10000000) SELECT count(*) AS n FROM c";
		const { adapter } = realFixture();
		const warn = mock((_line: string) => {});
		const lines = (needle: string) =>
			warn.mock.calls.filter(([line]) => line.includes(needle)).length;
		// Its own name per run, so threads an earlier run in this process left
		// are not counted. Linux keeps 15 characters of a thread name.
		const threadName = `orphan-${++realLane}`;
		const reader = new OffThreadReader({
			dbPath: adapter.getSQLiteDb().filename,
			busyTimeoutMs: 100,
			embeddedCode: "",
			sourceUrl,
			readTimeoutMs: 150,
			// Past any scan here even on a loaded host, so the cap is what holds
			// the lane and not the expiry.
			orphanExpiryMs: 60_000,
			threadName,
			warn,
		});
		cleanups.push(() => reader.close());
		const count = () => {
			let n = 0;
			for (const task of readdirSync("/proc/self/task")) {
				try {
					const comm = readFileSync(`/proc/self/task/${task}/comm`, "utf8");
					if (comm.trimEnd() === threadName) n++;
				} catch {}
			}
			return n;
		};
		// A thread whose close event has fired has finished its statement and is
		// being torn down, so one sample over two is read again shortly after.
		const threads = async () => {
			const n = count();
			if (n <= 2) return n;
			await sleep(100);
			return count();
		};
		// Before the cap every round left one more scan running: six threads at
		// the end of five rounds, each on its own core.
		let peak = 0;
		for (let round = 0; round < 5; round++) {
			await reader.all(SLOW).catch(() => {});
			peak = Math.max(peak, await threads());
			await reader.get("SELECT i FROM sample").catch(() => {});
			peak = Math.max(peak, await threads());
		}
		// Two, not fewer: the first timed-out scan still runs beside the worker
		// that serves the next read, so a counter that sees no threads fails here.
		expect(peak).toBe(2);
		// Each timed-out worker is counted until its close event.
		for (
			let i = 0;
			i < 300 &&
			lines("terminated worker exited after") < lines("read timeout");
			i++
		)
			await sleep(100);
		expect(lines("read timeout")).toBeGreaterThanOrEqual(1);
		expect(lines("terminated worker exited after")).toBe(lines("read timeout"));
		expect(lines("no longer counted")).toBe(0);
		expect(count()).toBeLessThanOrEqual(1);
		expect(await reader.get("SELECT i FROM sample")).toEqual({ i: 42 });
	}, 60_000);
});
