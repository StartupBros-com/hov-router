#!/usr/bin/env bun
/**
 * Full-filesystem scenario for the router backend.
 *
 * Runs the real server with its database, config, log and temp directories on
 * a size-capped filesystem the caller mounted, fills that filesystem to zero
 * free blocks and keeps it there, then reports whether the server keeps
 * serving, restarts, and resumes recording once space returns. Upstream is a
 * local stub and the account is anthropic-compatible, so no provider is
 * contacted.
 *
 * Usage:
 *   bun run apps/server/src/disk-full-scenario.ts --dir <mounted dir>
 *     [--binary <compiled cli>] [--soak-ms <n>]
 *     [--restart-loops <n>] [--pressure timer|spin] [--spin-pause-us <n>]
 *     [--wal-frames <n>] [--index-slack] [--pad-index-bytes <n>]
 *     [--named-steps <a,b>] [--kill-pause-ms <n>]
 *     [--loop-signal alternate|term] [--loop-continue]
 *     [--start-reserve-bytes <n>] [--quiet-start]
 *     [--rearm-router-reserve]
 *
 * `--restart-loops` repeats the restart on the full filesystem, alternating a
 * clean stop and a kill, and stops at the first start that fails
 * (`--loop-signal term` stops cleanly every time; `--loop-continue` keeps
 * going after a failed start and reports every iteration). `--pressure
 * spin` adds a second process that retries a 4 KiB append, so a block the
 * router releases even for microseconds can be taken; `--spin-pause-us` sets
 * the pause between its attempts (default 0, which no start survives: SQLite
 * releases and retakes the WAL index's pages when it opens the database).
 * `--wal-frames` leaves that many frames in the write-ahead log before the
 * fill; above 4,062 the index a start rebuilds no longer fits one 32 KiB
 * region. `--index-slack` then folds those frames into the database before
 * the fill, which leaves the index at the larger size while the log needs one
 * region: the shape of a long-running install, where a start frees more index
 * pages than it has to take back. `--pad-index-bytes` gets the same margin a
 * different way: this process appends that many zero bytes to the index file
 * before the fill and tries to put them back after every start, which measures
 * whether such a margin can be kept once the filesystem is full.
 * `--named-steps` picks which of `clean-stop`, `crash` and
 * `clean-stop-no-log-dir` run, and `--kill-pause-ms` waits between a kill and
 * the next start. `--start-reserve-bytes` measures a margin that touches no
 * SQLite file: this process keeps a file of that many written bytes next to
 * the database, removes it just before each start and writes it again
 * afterwards. With `--quiet-start` the refill does not run between the
 * removal and the end of the start, which is the case where the process that
 * opens the database releases the reserve itself and nothing else gets a turn
 * in between.
 *
 * The router keeps a start reserve of its own and releases it when a start
 * cannot open the database. Every start reports that file's size before and
 * after, and whether the router said it released it. A reserve spent on a
 * full filesystem cannot be written back, so by default only the first start
 * has one. `--rearm-router-reserve` makes room before each stop and waits for
 * the running router to write its reserve back, the way returning space
 * would, so every start is measured with one.
 *
 * Prints one JSON report on stdout. Exit 0 means the scenario ran (read
 * `failures`); exit 2 means the harness itself could not run.
 */
import { Database } from "bun:sqlite";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	rmSync,
	statfsSync,
	statSync,
	truncateSync,
	writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	START_RESERVE_BYTES,
	startReservePath,
} from "@better-ccflare/database";

const STUB_MARKER = "disk-full-scenario-stub-reply";
const REPO_ROOT = resolve(import.meta.dir, "../../..");
const SERVER_ENTRY = join(REPO_ROOT, "apps/server/src/server.ts");

interface Args {
	dir: string;
	binary: string | null;
	soakMs: number;
	/** Stop after the baseline and leave the files in place. Never fills. */
	baselineOnly: boolean;
	/** Extra restarts on the full filesystem, alternating SIGTERM and SIGKILL. */
	restartLoops: number;
	/** `spin` adds a process that keeps trying to take freed blocks. */
	pressure: "timer" | "spin";
	/** Pause between the spinner's attempts, in microseconds. */
	spinPauseUs: number;
	/** Frames to leave in the write-ahead log before the fill. 0 leaves it as is. */
	walFrames: number;
	/** Checkpoint the seeded frames before the fill, keeping the index large. */
	indexSlack: boolean;
	/** Zero bytes to keep past the end of the WAL index. 0 leaves it as is. */
	padIndexBytes: number;
	/** Which of the named restart steps run, in their fixed order. */
	namedSteps: StepName[];
	/** Wait this long between a SIGKILL and the next start. */
	killPauseMs: number;
	/** `term` stops the loop's server cleanly every time. */
	loopSignal: "alternate" | "term";
	/** Keep looping after a failed start, and loop even with nothing running. */
	loopContinue: boolean;
	/** Written bytes kept in a file beside the database and released per start. */
	startReserveBytes: number;
	/** Hold the refill from the release of the reserve to the end of the start. */
	quietStart: boolean;
	/** Make room before each stop so the router writes its own reserve back. */
	rearmRouterReserve: boolean;
}

/** Room given back so the running router can write its start reserve. */
const ROUTER_REARM_ROOM_BYTES = 1024 * 1024;
/** Longer than the router's 30 s reserve check. */
const ROUTER_REARM_WAIT_MS = 45_000;
/** Part of the line the router logs after a start that spent its reserve. */
const ROUTER_RESERVE_RELEASED_MARKER = "start reserve and opened it";

const STEP_NAMES = ["clean-stop", "crash", "clean-stop-no-log-dir"] as const;
type StepName = (typeof STEP_NAMES)[number];

function parseArgs(argv: string[]): Args {
	let dir = "";
	let binary: string | null = null;
	let soakMs = 20_000;
	let baselineOnly = false;
	let restartLoops = 0;
	let pressure: Args["pressure"] = "timer";
	let spinPauseUs = 0;
	let walFrames = 0;
	let indexSlack = false;
	let padIndexBytes = 0;
	let namedSteps: StepName[] = [...STEP_NAMES];
	let killPauseMs = 0;
	let loopSignal: Args["loopSignal"] = "alternate";
	let loopContinue = false;
	let startReserveBytes = 0;
	let quietStart = false;
	let rearmRouterReserve = false;
	for (let i = 0; i < argv.length; i++) {
		const value = argv[i + 1];
		if (argv[i] === "--rearm-router-reserve") rearmRouterReserve = true;
		if (argv[i] === "--quiet-start") quietStart = true;
		if (argv[i] === "--start-reserve-bytes" && value) {
			startReserveBytes = Number(value);
		}
		if (argv[i] === "--index-slack") indexSlack = true;
		if (argv[i] === "--loop-continue") loopContinue = true;
		if (argv[i] === "--pad-index-bytes" && value) padIndexBytes = Number(value);
		if (argv[i] === "--kill-pause-ms" && value) killPauseMs = Number(value);
		if (argv[i] === "--loop-signal" && value) {
			if (value !== "alternate" && value !== "term") {
				throw new Error("--loop-signal must be alternate or term");
			}
			loopSignal = value;
		}
		if (argv[i] === "--named-steps" && value) {
			const wanted = value.split(",").filter(Boolean);
			const unknown = wanted.filter(
				(name) => !STEP_NAMES.includes(name as StepName),
			);
			if (unknown.length > 0) {
				throw new Error(
					`--named-steps takes ${STEP_NAMES.join(", ")}; got ${unknown.join(", ")}`,
				);
			}
			namedSteps = STEP_NAMES.filter((name) => wanted.includes(name));
		}
		if (argv[i] === "--wal-frames" && value) walFrames = Number(value);
		if (argv[i] === "--restart-loops" && value) restartLoops = Number(value);
		if (argv[i] === "--spin-pause-us" && value) spinPauseUs = Number(value);
		if (argv[i] === "--pressure" && value) {
			if (value !== "timer" && value !== "spin") {
				throw new Error("--pressure must be timer or spin");
			}
			pressure = value;
		}
		if (argv[i] === "--dir" && value) dir = value;
		if (argv[i] === "--binary" && value) binary = value;
		if (argv[i] === "--soak-ms" && value) soakMs = Number(value);
		if (argv[i] === "--baseline-only") baselineOnly = true;
	}
	if (!dir) throw new Error("--dir <mounted directory> is required");
	if (!Number.isFinite(soakMs) || soakMs < 0) {
		throw new Error("--soak-ms must be a non-negative number");
	}
	if (!Number.isInteger(restartLoops) || restartLoops < 0) {
		throw new Error("--restart-loops must be a non-negative integer");
	}
	if (!Number.isFinite(spinPauseUs) || spinPauseUs < 0) {
		throw new Error("--spin-pause-us must be a non-negative number");
	}
	if (!Number.isInteger(walFrames) || walFrames < 0) {
		throw new Error("--wal-frames must be a non-negative integer");
	}
	if (indexSlack && walFrames <= FRAMES_PER_INDEX_REGION) {
		throw new Error(
			`--index-slack needs --wal-frames above ${FRAMES_PER_INDEX_REGION}, or the index never grows past one region`,
		);
	}
	if (
		!Number.isInteger(padIndexBytes) ||
		padIndexBytes < 0 ||
		padIndexBytes % PAGE_BYTES !== 0
	) {
		throw new Error(
			`--pad-index-bytes must be a non-negative multiple of ${PAGE_BYTES}`,
		);
	}
	if (!Number.isFinite(killPauseMs) || killPauseMs < 0) {
		throw new Error("--kill-pause-ms must be a non-negative number");
	}
	if (
		!Number.isInteger(startReserveBytes) ||
		startReserveBytes < 0 ||
		startReserveBytes % PAGE_BYTES !== 0
	) {
		throw new Error(
			`--start-reserve-bytes must be a non-negative multiple of ${PAGE_BYTES}`,
		);
	}
	if (quietStart && startReserveBytes === 0) {
		throw new Error("--quiet-start needs --start-reserve-bytes");
	}
	if (rearmRouterReserve && pressure !== "timer") {
		throw new Error(
			"--rearm-router-reserve needs --pressure timer: the spinner takes the room before the router can",
		);
	}
	return {
		dir: resolve(dir),
		binary,
		soakMs,
		baselineOnly,
		restartLoops,
		pressure,
		spinPauseUs,
		walFrames,
		indexSlack,
		padIndexBytes,
		namedSteps,
		killPauseMs,
		loopSignal,
		loopContinue,
		startReserveBytes,
		quietStart,
		rearmRouterReserve,
	};
}

function freeBytes(dir: string): number {
	const stats = statfsSync(dir);
	return Number(stats.bavail) * Number(stats.bsize);
}

/**
 * Free blocks and the ones an ordinary write may take. On ext4 the first stays
 * above zero when the second is zero: the difference is held back for root
 * and for the filesystem's own bookkeeping.
 */
function blockCounts(dir: string): { free: number; available: number } {
	const stats = statfsSync(dir);
	return { free: Number(stats.bfree), available: Number(stats.bavail) };
}

/** Largest filesystem the scenario agrees to fill. */
const MAX_SCENARIO_FILESYSTEM_BYTES = 1 << 30;

/**
 * The fill phase writes until nothing is left, so it must only ever run on a
 * small filesystem mounted for it. Pointed at an ordinary directory it would
 * fill the host's disk, which is the outage this scenario exists to prevent.
 */
function assertDedicatedSmallMount(dir: string): void {
	if (statSync(dir).dev === statSync(dirname(dir)).dev) {
		throw new Error(
			`${dir} is not a mount point; mount a size-capped tmpfs there first`,
		);
	}
	const stats = statfsSync(dir);
	const total = Number(stats.blocks) * Number(stats.bsize);
	if (total > MAX_SCENARIO_FILESYSTEM_BYTES) {
		throw new Error(
			`${dir} is ${total} bytes; the scenario only fills filesystems up to ${MAX_SCENARIO_FILESYSTEM_BYTES} bytes`,
		);
	}
}

/**
 * Append to the ballast file until the filesystem has no free block left.
 * Called repeatedly, it plays the co-tenant that takes back anything the
 * router frees (a truncated WAL, a rotated log).
 */
function fillToZero(ballastPath: string): number {
	const fd = openSync(ballastPath, "a");
	let written = 0;
	try {
		for (const size of [1 << 20, 4096]) {
			const chunk = Buffer.alloc(size, 0x62);
			while (true) {
				let count = 0;
				try {
					count = writeSync(fd, chunk);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOSPC") break;
					throw error;
				}
				if (count === 0) break;
				written += count;
			}
		}
	} finally {
		closeSync(fd);
	}
	return written;
}

/**
 * The `--spin <file> <pause µs>` child: retries a 4 KiB append forever. With
 * no pause it plays a co-tenant that never backs off, which is the worst case
 * for anything that releases a block and expects to get it back.
 */
function spinForever(path: string, pauseUs: number): never {
	assertDedicatedSmallMount(dirname(path));
	const fd = openSync(path, "a");
	const chunk = Buffer.alloc(4096, 0x73);
	while (true) {
		try {
			writeSync(fd, chunk);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOSPC") throw error;
		}
		if (pauseUs > 0) Bun.sleepSync(pauseUs / 1000);
	}
}

const SEED_REQUEST_ROWS = 300;
const SEED_PAYLOAD_ROWS = 40;
const SEED_ID_PREFIX = "seed-old-";
const PAGE_BYTES = 4096;
/** Frames one 32 KiB region of the WAL index can describe. */
const FRAMES_PER_INDEX_REGION = 4062;
const INDEX_REGION_BYTES = 32768;

/**
 * Give the next boot real cleanup work: request rows and payloads far past
 * retention, and an expired OAuth session. Must run while the server is up, so
 * this connection is never the first to open the database or the last to
 * close it.
 */
function seedBootWork(dbFile: string): Record<string, number> {
	const db = new Database(dbFile, { readwrite: true, create: false });
	try {
		db.run("PRAGMA busy_timeout = 10000");
		const old = Date.now() - 400 * 24 * 60 * 60 * 1000;
		const insertRequest = db.prepare(
			"INSERT INTO requests (id, timestamp, method, path, status_code, success) VALUES (?, ?, 'POST', '/v1/messages', 200, 1)",
		);
		const insertPayload = db.prepare(
			"INSERT INTO request_payloads (id, json, timestamp) VALUES (?, ?, ?)",
		);
		db.transaction(() => {
			for (let i = 0; i < SEED_REQUEST_ROWS; i++) {
				insertRequest.run(`seed-old-${i}`, old + i);
				if (i < SEED_PAYLOAD_ROWS) {
					insertPayload.run(`seed-old-${i}`, '{"seed":true}', old + i);
				}
			}
			db.run(
				"INSERT INTO oauth_sessions (id, account_name, verifier, mode, priority, created_at, expires_at) VALUES ('seed-expired', 'seed', 'seed', 'claude-oauth', 0, ?, ?)",
				[old, old + 1000],
			);
		})();
		insertRequest.finalize();
		insertPayload.finalize();
		return seededRows(db);
	} finally {
		db.close();
	}
}

/**
 * Leave about `frames` frames in the write-ahead log, as a burst of traffic
 * since the last checkpoint would. Each payload row fills one page that the
 * database file does not have yet, so a checkpoint on the full filesystem
 * cannot move them and every later start has to rebuild an index for all of
 * them. Autocheckpoint is off on this connection for the same reason the
 * server turns it off: the commit must not fold the log back itself.
 *
 * With `checkpointAfter` the frames are then folded into the database, as the
 * server's own once-a-minute checkpoint would. The log empties; the index
 * keeps the size the burst grew it to.
 */
function seedLargeWal(
	dbFile: string,
	frames: number,
	checkpointAfter: boolean,
): number | null {
	const db = new Database(dbFile, { readwrite: true, create: false });
	try {
		db.run("PRAGMA busy_timeout = 10000");
		db.run("PRAGMA wal_autocheckpoint = 0");
		const old = Date.now() - 400 * 24 * 60 * 60 * 1000;
		const insertRequest = db.prepare(
			"INSERT INTO requests (id, timestamp, method, path, status_code, success) VALUES (?, ?, 'POST', '/v1/messages', 200, 1)",
		);
		const insertPayload = db.prepare(
			"INSERT INTO request_payloads (id, json, timestamp) VALUES (?, ?, ?)",
		);
		const json = JSON.stringify({ seed: "x".repeat(3500) });
		db.transaction(() => {
			for (let i = 0; i < frames; i++) {
				const id = `${SEED_ID_PREFIX}wal-${i}`;
				insertRequest.run(id, old + i);
				insertPayload.run(id, json, old + i);
			}
		})();
		insertRequest.finalize();
		insertPayload.finalize();
		if (checkpointAfter) {
			const outcome = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as {
				busy: number;
			};
			if (outcome.busy !== 0) {
				throw new Error(
					"the checkpoint before the fill was blocked, so the index-slack starts were not measured",
				);
			}
		}
	} finally {
		db.close();
	}
	return fileSize(`${dbFile}-wal`);
}

function seededRows(db: Database): Record<string, number> {
	const count = (sql: string) => (db.query(sql).get() as { n: number }).n;
	return {
		requests: count(
			"SELECT COUNT(*) AS n FROM requests WHERE id LIKE 'seed-old-%'",
		),
		payloads: count(
			"SELECT COUNT(*) AS n FROM request_payloads WHERE id LIKE 'seed-old-%'",
		),
		oauthSessions: count(
			"SELECT COUNT(*) AS n FROM oauth_sessions WHERE id = 'seed-expired'",
		),
	};
}

/** Read-only count of the seeded rows. Only call while the server is up. */
function seededRowsRemaining(dbFile: string): Record<string, number> | null {
	try {
		const db = new Database(dbFile, { readonly: true });
		try {
			return seededRows(db);
		} finally {
			db.close();
		}
	} catch {
		return null;
	}
}

async function reservePort(): Promise<number> {
	const probe = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response("probe"),
	});
	const port = probe.port;
	await probe.stop(true);
	if (typeof port !== "number") throw new Error("could not reserve a port");
	return port;
}

async function drain(
	stream: ReadableStream<Uint8Array> | null | undefined,
	sink: string[],
): Promise<void> {
	if (!stream) return;
	const decoder = new TextDecoder();
	try {
		for await (const chunk of stream) {
			for (const line of decoder.decode(chunk, { stream: true }).split("\n")) {
				if (!line) continue;
				sink.push(line.length > 400 ? `${line.slice(0, 400)}…` : line);
				if (sink.length > 2000) sink.shift();
			}
		}
	} catch {
		// The pipe closes when the server exits.
	}
}

interface ExitInfo {
	exitCode: number | null;
	signal: string | null;
}

class RouterProcess {
	private proc: ReturnType<typeof Bun.spawn> | null = null;
	readonly output: string[] = [];
	exit: ExitInfo | null = null;

	constructor(
		private readonly args: Args,
		private readonly port: number,
	) {}

	get base(): string {
		return `http://127.0.0.1:${this.port}`;
	}

	get pid(): number | null {
		return this.proc?.pid ?? null;
	}

	alive(): boolean {
		return this.proc !== null && this.exit === null;
	}

	/** Everything the server printed since its most recent start. */
	outputSinceStart(): string[] {
		let from = 0;
		this.output.forEach((line, index) => {
			if (line.startsWith("--- start ")) from = index + 1;
		});
		return this.output.slice(from);
	}

	start(): void {
		const { dir, binary } = this.args;
		const command = binary
			? [binary, "--serve", "--port", String(this.port)]
			: [
					process.execPath,
					"--no-env-file",
					"run",
					SERVER_ENTRY,
					"--port",
					String(this.port),
				];
		this.exit = null;
		this.output.push(`--- start ${command.join(" ")}`);
		const proc = Bun.spawn(command, {
			cwd: binary ? dir : REPO_ROOT,
			env: {
				PATH: process.env.PATH ?? "/usr/bin:/bin",
				HOME: join(dir, "home"),
				XDG_CONFIG_HOME: join(dir, "config"),
				TMPDIR: join(dir, "tmp"),
				BETTER_CCFLARE_DB_PATH: join(
					dir,
					"config/better-ccflare/better-ccflare.db",
				),
				// Production's runner sets the same level, so the log volume matches.
				LOG_LEVEL: "warn",
				CCFLARE_SHUTDOWN_DRAIN_MS: "1000",
				// Keep Bun's own transpiler cache off the full filesystem: the
				// scenario is about the router's writes, not the runtime's.
				BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		this.proc = proc;
		void drain(proc.stdout as ReadableStream<Uint8Array>, this.output);
		void drain(proc.stderr as ReadableStream<Uint8Array>, this.output);
		void proc.exited.then((exitCode) => {
			if (this.proc !== proc) return;
			this.exit = {
				exitCode,
				signal: proc.signalCode ?? null,
			};
			this.output.push(
				`--- exit code=${exitCode} signal=${proc.signalCode ?? "none"}`,
			);
		});
	}

	/**
	 * `/health` answers 503 until an account exists, so the first boot only
	 * waits for the listener; later boots wait for a 200.
	 */
	async waitHealthy(timeoutMs: number, anyStatus = false): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (!this.alive()) return false;
			try {
				const response = await fetch(`${this.base}/health`, {
					signal: AbortSignal.timeout(2000),
				});
				await response.arrayBuffer();
				if (response.ok || anyStatus) return true;
			} catch {
				// Not listening yet.
			}
			await Bun.sleep(250);
		}
		return false;
	}

	async stop(signal: "SIGTERM" | "SIGKILL", timeoutMs: number): Promise<void> {
		const proc = this.proc;
		if (!proc || this.exit !== null) return;
		proc.kill(signal);
		const timedOut = await Promise.race([
			proc.exited.then(() => false),
			Bun.sleep(timeoutMs).then(() => true),
		]);
		if (timedOut) {
			this.output.push(
				`--- ${signal} did not stop the server; sending SIGKILL`,
			);
			proc.kill("SIGKILL");
			await proc.exited;
		}
		// Let the exit handler above record the status.
		await Bun.sleep(20);
	}
}

interface MessageResult {
	status: number;
	served: boolean;
	error?: string;
}

async function sendMessage(
	base: string,
	accountId: string,
	label: string,
): Promise<MessageResult> {
	try {
		const response = await fetch(`${base}/v1/messages`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: "Bearer scenario",
				"anthropic-version": "2023-06-01",
				"x-better-ccflare-account-id": accountId,
			},
			body: JSON.stringify({
				model: "claude-haiku-4-5",
				max_tokens: 16,
				messages: [{ role: "user", content: `disk-full scenario ${label}` }],
			}),
			signal: AbortSignal.timeout(20_000),
		});
		const text = await response.text();
		return {
			status: response.status,
			served: response.status === 200 && text.includes(STUB_MARKER),
			...(response.status === 200 ? {} : { error: text.slice(0, 300) }),
		};
	} catch (error) {
		return { status: 0, served: false, error: String(error).slice(0, 300) };
	}
}

async function sendBatch(
	base: string,
	accountId: string,
	label: string,
	count: number,
): Promise<{ sent: number; served: number; failures: MessageResult[] }> {
	const failures: MessageResult[] = [];
	let served = 0;
	for (let i = 0; i < count; i++) {
		const result = await sendMessage(base, accountId, `${label}-${i}`);
		if (result.served) served++;
		else failures.push(result);
	}
	return { sent: count, served, failures: failures.slice(0, 3) };
}

/**
 * Requests the router itself recorded. Seeded rows are left out: the retention
 * sweep deletes them once it can write again, which would otherwise read as
 * recorded requests disappearing.
 */
async function recordedRows(
	base: string,
): Promise<Array<Record<string, unknown>> | null> {
	try {
		const response = await fetch(`${base}/api/requests?limit=1000`, {
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) return null;
		const body = (await response.json()) as unknown;
		const rows = Array.isArray(body)
			? body
			: (body as { requests?: unknown }).requests;
		if (!Array.isArray(rows)) return null;
		return rows.filter((row) => {
			const id = (row as { id?: unknown } | null)?.id;
			return !(typeof id === "string" && id.startsWith(SEED_ID_PREFIX));
		}) as Array<Record<string, unknown>>;
	} catch {
		return null;
	}
}

async function recordedRequests(base: string): Promise<number | null> {
	return (await recordedRows(base))?.length ?? null;
}

async function health(base: string): Promise<unknown> {
	try {
		const response = await fetch(`${base}/health`, {
			signal: AbortSignal.timeout(5000),
		});
		return { status: response.status, body: await response.json() };
	} catch (error) {
		return { status: 0, error: String(error).slice(0, 200) };
	}
}

function fileSize(path: string): number | null {
	try {
		return statSync(path).size;
	} catch {
		return null;
	}
}

function sideFiles(dbFile: string) {
	return {
		db: fileSize(dbFile),
		wal: fileSize(`${dbFile}-wal`),
		shm: fileSize(`${dbFile}-shm`),
		// In 512-byte units, as stat reports them: a sparse index would show a
		// size without the blocks a start gets back by truncating it.
		shmBlocks: fileBlocks(`${dbFile}-shm`),
	};
}

function fileBlocks(path: string): number | null {
	try {
		return statSync(path).blocks;
	} catch {
		return null;
	}
}

interface PadResult {
	ok: boolean;
	sizeBefore: number | null;
	sizeAfter: number | null;
	blocksBefore: number | null;
	blocksAfter: number | null;
	pagesWritten: number;
	error?: string;
}

/**
 * Append zero-filled pages past the end of the WAL index. They are written,
 * not left as a hole, because only allocated blocks come back when the next
 * start truncates the file.
 *
 * Measurement only. A router must not do this to its own index, for two
 * reasons. Closing any descriptor on the index file drops every POSIX lock
 * the process holds on it, so this is only safe from a process with no SQLite
 * connection on the database. And the write is not atomic with SQLite growing
 * the index: a connection that maps the next region between the size check
 * here and the write gets its new entries overwritten with zeros. The
 * scenario sends no traffic while it pads.
 */
function padIndex(shmPath: string, padBytes: number): PadResult {
	let before: { size: number; blocks: number } | null = null;
	try {
		before = statSync(shmPath);
	} catch {
		// Reported below.
	}
	const result: PadResult = {
		ok: false,
		sizeBefore: before?.size ?? null,
		sizeAfter: null,
		blocksBefore: before?.blocks ?? null,
		blocksAfter: null,
		pagesWritten: 0,
	};
	if (
		!before ||
		before.size < INDEX_REGION_BYTES ||
		before.size % PAGE_BYTES !== 0
	) {
		result.error = "the index is not a whole region";
		return result;
	}
	let fd: number | null = null;
	try {
		fd = openSync(shmPath, "r+");
		const page = Buffer.alloc(PAGE_BYTES);
		const end = before.size + padBytes;
		for (let offset = before.size; offset < end; offset += PAGE_BYTES) {
			writeSync(fd, page, 0, PAGE_BYTES, offset);
			result.pagesWritten++;
		}
		fsyncSync(fd);
		result.ok = true;
	} catch (error) {
		result.error = (error as NodeJS.ErrnoException).code ?? String(error);
	} finally {
		if (fd !== null) closeSync(fd);
	}
	try {
		const after = statSync(shmPath);
		result.sizeAfter = after.size;
		result.blocksAfter = after.blocks;
	} catch {
		// The size fields stay null.
	}
	return result;
}

interface ReserveResult {
	ok: boolean;
	pagesWritten: number;
	blocks: number | null;
	error?: string;
}

/**
 * Write the start reserve: real bytes, not a hole, because only allocated
 * blocks are released when the file is removed.
 */
function writeReserve(reservePath: string, bytes: number): ReserveResult {
	const result: ReserveResult = { ok: false, pagesWritten: 0, blocks: null };
	let fd: number | null = null;
	try {
		fd = openSync(reservePath, "w");
		const page = Buffer.alloc(PAGE_BYTES);
		for (let offset = 0; offset < bytes; offset += PAGE_BYTES) {
			writeSync(fd, page, 0, PAGE_BYTES, offset);
			result.pagesWritten++;
		}
		fsyncSync(fd);
		result.ok = true;
	} catch (error) {
		result.error = (error as NodeJS.ErrnoException).code ?? String(error);
	} finally {
		if (fd !== null) closeSync(fd);
	}
	result.blocks = fileBlocks(reservePath);
	return result;
}

/**
 * Put the pad back after a start. The start truncates the index and rebuilds
 * it, so this waits for the file to change and then hold one size across two
 * looks, 5 ms apart, before appending. That is later than a router padding
 * its own index could manage, so a pad this restores is not flattered.
 */
async function restorePad(
	shmPath: string,
	padBytes: number,
	changedSinceMs: number | null,
	alive: () => boolean,
	timeoutMs: number,
): Promise<PadResult & { waitedMs: number }> {
	const startedAt = Date.now();
	let lastSize = -1;
	while (Date.now() - startedAt < timeoutMs && alive()) {
		let stats: { size: number; ctimeMs: number } | null = null;
		try {
			stats = statSync(shmPath);
		} catch {
			// Not there yet.
		}
		const rebuilt =
			stats !== null &&
			stats.ctimeMs !== changedSinceMs &&
			stats.size >= INDEX_REGION_BYTES &&
			stats.size % PAGE_BYTES === 0;
		if (rebuilt && stats?.size === lastSize) {
			return {
				...padIndex(shmPath, padBytes),
				waitedMs: Date.now() - startedAt,
			};
		}
		lastSize = rebuilt ? (stats?.size ?? -1) : -1;
		await Bun.sleep(5);
	}
	return {
		ok: false,
		sizeBefore: fileSize(shmPath),
		sizeAfter: null,
		blocksBefore: fileBlocks(shmPath),
		blocksAfter: null,
		pagesWritten: 0,
		error: alive()
			? "the index was not rebuilt in time"
			: "the server exited before the index was rebuilt",
		waitedMs: Date.now() - startedAt,
	};
}

function changeTimeMs(path: string): number | null {
	try {
		return statSync(path).ctimeMs;
	} catch {
		return null;
	}
}

/** What a start that failed printed: its error codes, messages and where it threw. */
function startFailureDetail(lines: string[]): {
	codes: string[];
	errors: string[];
	frames: string[];
} {
	const codes = new Set<string>();
	const errors: string[] = [];
	const frames: string[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		const code = trimmed.match(/code: "([A-Z_0-9]+)"/);
		if (code?.[1]) codes.add(code[1]);
		if (trimmed.startsWith("at ")) {
			if (frames.length < 4) frames.push(trimmed.slice(0, 240));
		} else if (/\berror\b/i.test(trimmed) && !trimmed.startsWith("--- ")) {
			if (errors.length < 4) errors.push(trimmed.slice(0, 240));
		}
	}
	return { codes: [...codes], errors, frames };
}

/**
 * Make the router write one ERROR line to its log file: an account-creation
 * request with no name is rejected and logged, and changes nothing.
 */
async function provokeLogLine(base: string): Promise<void> {
	try {
		const response = await fetch(`${base}/api/accounts/anthropic-compatible`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
			signal: AbortSignal.timeout(5000),
		});
		await response.arrayBuffer();
	} catch {
		// The caller measures the log file, not this response.
	}
}

/** What the startup retention sweep reported, once it has reported anything. */
async function retentionOutcome(base: string): Promise<unknown> {
	let seen: unknown = null;
	await waitFor(async () => {
		const result = (await health(base)) as {
			body?: { runtime?: { storage?: { retention?: unknown } } };
		};
		const retention = result.body?.runtime?.storage?.retention as
			| { lastSuccessAt?: unknown; lastError?: unknown }
			| undefined;
		if (!retention) return false;
		seen = retention;
		return Boolean(retention.lastSuccessAt || retention.lastError);
	}, 20_000);
	return seen;
}

async function waitFor(
	check: () => Promise<boolean>,
	timeoutMs: number,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return true;
		await Bun.sleep(500);
	}
	return false;
}

/** The lines around every start and exit, which is where a death explains itself. */
function exitContext(output: string[]): string[] {
	const keep = new Set<number>();
	output.forEach((line, index) => {
		if (!line.startsWith("--- ")) return;
		for (let i = Math.max(0, index - 25); i <= index; i++) keep.add(i);
	});
	for (let i = Math.max(0, output.length - 15); i < output.length; i++) {
		keep.add(i);
	}
	return [...keep].sort((a, b) => a - b).map((i) => output[i] as string);
}

async function main(): Promise<void> {
	const spinIndex = process.argv.indexOf("--spin");
	if (spinIndex >= 0) {
		spinForever(
			process.argv[spinIndex + 1] as string,
			Number(process.argv[spinIndex + 2] ?? 0),
		);
	}
	const args = parseArgs(process.argv.slice(2));
	if (!existsSync(args.dir)) throw new Error(`${args.dir} does not exist`);
	if (args.binary && !existsSync(args.binary)) {
		throw new Error(`compiled binary ${args.binary} does not exist`);
	}
	if (!args.baselineOnly) assertDedicatedSmallMount(args.dir);
	for (const sub of ["home", "config", "tmp"]) {
		mkdirSync(join(args.dir, sub), { recursive: true });
	}
	const ballast = join(args.dir, "ballast.bin");
	const spinFile = join(args.dir, "spin.bin");
	const logFile = join(args.dir, "tmp/better-ccflare-logs/app.log");
	const dbFile = join(args.dir, "config/better-ccflare/better-ccflare.db");
	const shmFile = `${dbFile}-shm`;
	// This process's own measurement reserve (`--start-reserve-bytes`), kept
	// apart from the reserve the router owns.
	const reserveFile = `${dbFile}.scenario-reserve`;
	const routerReserveFile = startReservePath(dbFile);
	/** True while a start holds the refill off (`--quiet-start`). */
	let refillHeld = false;
	const failures: string[] = [];
	const report: Record<string, unknown> = {
		mode: args.binary ? "compiled" : "source",
		capacityBytes: freeBytes(args.dir),
	};

	let upstreamHits = 0;
	const upstream = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			upstreamHits++;
			await request.arrayBuffer();
			return Response.json({
				id: `msg_scenario_${upstreamHits}`,
				type: "message",
				role: "assistant",
				model: "claude-haiku-4-5",
				content: [{ type: "text", text: STUB_MARKER }],
				stop_reason: "end_turn",
				stop_sequence: null,
				usage: { input_tokens: 9, output_tokens: 3 },
			});
		},
	});

	const router = new RouterProcess(args, await reservePort());
	let refill: ReturnType<typeof setInterval> | null = null;
	let spinner: ReturnType<typeof Bun.spawn> | null = null;
	const stopPressure = async () => {
		if (refill) clearInterval(refill);
		refill = null;
		if (spinner) {
			spinner.kill("SIGKILL");
			await spinner.exited;
			spinner = null;
		}
		rmSync(ballast, { force: true });
		rmSync(spinFile, { force: true });
	};
	try {
		// 1. Baseline, with space available.
		router.start();
		if (!(await router.waitHealthy(60_000, true))) {
			throw new Error("server did not start listening with space available");
		}
		const created = await fetch(
			`${router.base}/api/accounts/anthropic-compatible`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					name: "disk-full-stub",
					apiKey: "scenario-key",
					priority: 0,
					customEndpoint: `http://127.0.0.1:${upstream.port}`,
				}),
			},
		);
		const createdText = await created.text();
		const accountId = (() => {
			try {
				const parsed = JSON.parse(createdText) as {
					id?: string;
					account?: { id?: string };
				};
				return parsed.account?.id ?? parsed.id ?? null;
			} catch {
				return null;
			}
		})();
		if (!created.ok || !accountId) {
			throw new Error(
				`account creation failed: ${created.status} ${createdText.slice(0, 300)}`,
			);
		}

		const baseline = await sendBatch(router.base, accountId, "baseline", 5);
		const baselineRecorded = await waitFor(
			async () => ((await recordedRequests(router.base)) ?? 0) >= 5,
			30_000,
		);
		const recordedBaseline = await recordedRequests(router.base);
		report.baseline = { ...baseline, recorded: recordedBaseline };
		if (baseline.served !== baseline.sent || !baselineRecorded) {
			throw new Error(
				`baseline did not work, so the scenario proves nothing: ${JSON.stringify(report.baseline)}`,
			);
		}

		// Control for the log check in the recovery phase: with space available,
		// the provoked line reaches the log file.
		const logBytesAtBaseline = fileSize(logFile) ?? 0;
		await provokeLogLine(router.base);
		const logControl = await waitFor(
			async () => (fileSize(logFile) ?? 0) > logBytesAtBaseline,
			10_000,
		);
		if (!logControl) {
			throw new Error(
				"the provoked log line never reached the log file with space available, so the log check proves nothing",
			);
		}

		// A restart with space available: the control for the restarts below, and
		// it shows which database side files a clean stop leaves behind.
		await router.stop("SIGTERM", 20_000);
		const filesAfterCleanStop = sideFiles(dbFile);
		if (args.baselineOnly) {
			report.baselineOnly = { stopExit: router.exit, filesAfterCleanStop };
			report.failures = failures;
			console.log(JSON.stringify(report, null, 2));
			return;
		}
		router.start();
		const restartedWithSpace = await router.waitHealthy(60_000);
		report.restartWithSpace = {
			filesAfterCleanStop,
			healthy: restartedWithSpace,
		};
		if (!restartedWithSpace) {
			throw new Error(
				"the server did not restart with space available, so the scenario proves nothing",
			);
		}

		// Cleanup work for the boots on the full filesystem. It goes in after the
		// last boot with space, whose own startup sweep would have removed it.
		const retentionWithSpace = await retentionOutcome(router.base);
		// With index slack the burst goes in and is checkpointed first, so the
		// boot work below is what the log holds at the fill, as in a run without
		// a burst.
		let walBytesSeeded: number | null = null;
		if (args.walFrames > 0 && args.indexSlack) {
			walBytesSeeded = seedLargeWal(dbFile, args.walFrames, true);
		}
		const seededBootRows = seedBootWork(dbFile);
		if (args.walFrames > 0 && !args.indexSlack) {
			walBytesSeeded = seedLargeWal(dbFile, args.walFrames, false);
		}
		// The pad goes on with space available, after the seeding connections
		// above have closed.
		let padAtSeed: PadResult | null = null;
		if (args.padIndexBytes > 0) {
			padAtSeed = padIndex(shmFile, args.padIndexBytes);
			if (
				!padAtSeed.ok ||
				(padAtSeed.blocksAfter ?? 0) <= (padAtSeed.blocksBefore ?? 0)
			) {
				throw new Error(
					`the index could not be padded with space available, so the padded starts were not measured: ${JSON.stringify(padAtSeed)}`,
				);
			}
		}
		let reserveAtSeed: ReserveResult | null = null;
		if (args.startReserveBytes > 0) {
			reserveAtSeed = writeReserve(reserveFile, args.startReserveBytes);
			if (!reserveAtSeed.ok) {
				throw new Error(
					`the start reserve could not be written with space available: ${JSON.stringify(reserveAtSeed)}`,
				);
			}
		}
		report.seed = {
			rows: seededBootRows,
			retentionWithSpace,
			walFrames: args.walFrames,
			indexSlack: args.indexSlack,
			walBytesSeeded,
			padIndexBytes: args.padIndexBytes,
			padAtSeed,
			startReserveBytes: args.startReserveBytes,
			quietStart: args.quietStart,
			reserveAtSeed,
		};

		// 2. Fill the filesystem and keep it full.
		const filledBytes = fillToZero(ballast);
		refill = setInterval(() => {
			if (refillHeld) return;
			try {
				fillToZero(ballast);
			} catch {
				// The ballast is removed in the recovery phase.
			}
		}, 200);
		if (args.pressure === "spin") {
			spinner = Bun.spawn(
				[
					process.execPath,
					import.meta.path,
					"--spin",
					spinFile,
					String(args.spinPauseUs),
				],
				{ stdout: "ignore", stderr: "inherit" },
			);
		}
		report.fill = {
			filledBytes,
			freeAfterFill: freeBytes(args.dir),
			pressure: args.pressure,
			spinPauseUs: args.pressure === "spin" ? args.spinPauseUs : null,
		};
		if (freeBytes(args.dir) !== 0) {
			throw new Error("the filesystem still has free blocks after the fill");
		}
		if (args.walFrames > 0) {
			// The server checkpoints once a minute. One landing between the seed
			// and the fill empties the log, and the starts below would then prove
			// nothing about a large one.
			const walBytesAtFill = fileSize(`${dbFile}-wal`) ?? 0;
			const shmBytesAtFill = fileSize(`${dbFile}-shm`) ?? 0;
			(report.seed as Record<string, unknown>).walBytesAtFill = walBytesAtFill;
			(report.seed as Record<string, unknown>).shmBytesAtFill = shmBytesAtFill;
			if (args.indexSlack) {
				if (
					shmBytesAtFill < 2 * INDEX_REGION_BYTES ||
					walBytesAtFill >= FRAMES_PER_INDEX_REGION * PAGE_BYTES
				) {
					throw new Error(
						`at the fill the index held ${shmBytesAtFill} bytes and the write-ahead log ${walBytesAtFill}, which is not an index larger than the log needs, so the index-slack starts were not measured`,
					);
				}
			} else if (walBytesAtFill < args.walFrames * PAGE_BYTES) {
				throw new Error(
					`the write-ahead log held ${walBytesAtFill} bytes at the fill, fewer than the ${args.walFrames} frames seeded, so the large-log starts were not measured`,
				);
			}
		}

		// 3. Serve while full.
		const firstPid = router.pid;
		const full = await sendBatch(router.base, accountId, "full", 40);
		const soakStart = Date.now();
		let soakHealthFailures = 0;
		while (Date.now() - soakStart < args.soakMs && router.alive()) {
			const response = await fetch(`${router.base}/health`, {
				signal: AbortSignal.timeout(5000),
			}).catch(() => null);
			if (!response?.ok) soakHealthFailures++;
			await Bun.sleep(1000);
		}
		const afterSoak = router.alive()
			? await sendBatch(router.base, accountId, "after-soak", 10)
			: { sent: 10, served: 0, failures: [] };
		report.full = {
			requests: full,
			afterSoak,
			soakMs: args.soakMs,
			soakHealthFailures,
			alive: router.alive(),
			exit: router.exit,
			health: router.alive() ? await health(router.base) : null,
			logBytes: fileSize(logFile),
			freeBytes: freeBytes(args.dir),
		};
		if (!router.alive()) {
			failures.push(
				`the server exited while the filesystem was full: ${JSON.stringify(router.exit)}`,
			);
		}
		if (full.served !== full.sent) {
			failures.push(
				`only ${full.served} of ${full.sent} requests were served while full`,
			);
		}
		if (router.alive() && afterSoak.served !== afterSoak.sent) {
			failures.push(
				`only ${afterSoak.served} of ${afterSoak.sent} requests were served after the soak`,
			);
		}
		if (soakHealthFailures > 0) {
			failures.push(
				`${soakHealthFailures} health checks failed during the soak`,
			);
		}

		// 4. Restart on the still-full filesystem. A clean stop goes first: it
		// decides whether the write-ahead log and shared-memory files survive,
		// which is what the next open has to cope with. Then a crash, then a
		// clean stop with the log directory gone. A step that finds the server
		// already dead still tries the start, and says it measured a cold start.
		const restarts: Record<string, unknown> = {};
		const steps = (
			[
				{ name: "clean-stop", signal: "SIGTERM", removeLogDir: false },
				{ name: "crash", signal: "SIGKILL", removeLogDir: false },
				{
					name: "clean-stop-no-log-dir",
					signal: "SIGTERM",
					removeLogDir: true,
				},
			] as const
		).filter((step) => args.namedSteps.includes(step.name));
		/**
		 * Give the running router room to write its start reserve back, then
		 * take the room away again. Null when not asked for or nothing is running.
		 */
		const rearmRouterReserve = async () => {
			if (!args.rearmRouterReserve || !router.alive()) return null;
			const whole = () =>
				(fileSize(routerReserveFile) ?? 0) >= START_RESERVE_BYTES;
			if (whole()) return { needed: false, armed: true, waitedMs: 0 };
			const startedAt = Date.now();
			refillHeld = true;
			try {
				truncateSync(
					ballast,
					Math.max(0, (fileSize(ballast) ?? 0) - ROUTER_REARM_ROOM_BYTES),
				);
				const armed = await waitFor(async () => whole(), ROUTER_REARM_WAIT_MS);
				// The size is reached before the router's fsync returns.
				if (armed) await Bun.sleep(500);
				return { needed: true, armed, waitedMs: Date.now() - startedAt };
			} finally {
				fillToZero(ballast);
				refillHeld = false;
			}
		};
		/** Start the server on the full filesystem and report what the start did. */
		const startOnFull = async () => {
			// Whatever the stop released goes back to the co-tenant before the start.
			fillToZero(ballast);
			const freeBeforeStart = freeBytes(args.dir);
			const blocksBeforeStart = blockCounts(args.dir);
			const indexChangedAt = changeTimeMs(shmFile);
			let reserveBlocksReleased: number | null = null;
			let blocksAfterRelease: ReturnType<typeof blockCounts> | null = null;
			if (args.startReserveBytes > 0) {
				refillHeld = args.quietStart;
				reserveBlocksReleased = fileBlocks(reserveFile);
				rmSync(reserveFile, { force: true });
				blocksAfterRelease = blockCounts(args.dir);
			}
			const routerReserveBeforeStart = fileSize(routerReserveFile);
			const startedAt = Date.now();
			router.start();
			const padTask =
				args.padIndexBytes > 0
					? restorePad(
							shmFile,
							args.padIndexBytes,
							indexChangedAt,
							() => router.alive(),
							20_000,
						)
					: null;
			const healthy = await router.waitHealthy(60_000);
			const padRestore = padTask ? await padTask : null;
			const startMs = Date.now() - startedAt;
			// Put back after a failed start too, so every start is measured from
			// the same state; a router that failed to start could not do this.
			const reserveRestore =
				args.startReserveBytes > 0
					? writeReserve(reserveFile, args.startReserveBytes)
					: null;
			// When the server's own waiting writes have taken what the release
			// freed, the reserve cannot go back on a full filesystem. Make room
			// the way returning space would, so the next start has one again.
			let reserveRearmed: boolean | null = null;
			if (reserveRestore && !reserveRestore.ok) {
				try {
					truncateSync(
						ballast,
						Math.max(0, (fileSize(ballast) ?? 0) - 2 * args.startReserveBytes),
					);
					reserveRearmed = writeReserve(reserveFile, args.startReserveBytes).ok;
				} catch {
					reserveRearmed = false;
				}
			}
			refillHeld = false;
			return {
				freeBeforeStart,
				blocksBeforeStart,
				healthy,
				startMs,
				reserveBlocksReleased,
				blocksAfterRelease,
				reserveRestore,
				reserveRearmed,
				padRestore,
				routerReserveBeforeStart,
				routerReserveAfterStart: fileSize(routerReserveFile),
				// The router logs this line only after the open that follows
				// its release has succeeded.
				routerReleasedReserve: router
					.outputSinceStart()
					.some((line) => line.includes(ROUTER_RESERVE_RELEASED_MARKER)),
				filesAfterStart: sideFiles(dbFile),
				failure: healthy ? null : startFailureDetail(router.outputSinceStart()),
			};
		};
		for (const step of steps) {
			const startedFromLiveServer = router.alive();
			const routerReserveRearm = await rearmRouterReserve();
			await router.stop(step.signal, 20_000);
			const stopExit = router.exit;
			const filesAfterStop = sideFiles(dbFile);
			if (step.removeLogDir) {
				rmSync(dirname(logFile), { recursive: true, force: true });
			}
			if (step.signal === "SIGKILL" && args.killPauseMs > 0) {
				await Bun.sleep(args.killPauseMs);
			}
			const start = await startOnFull();
			const healthy = start.healthy;
			const served = healthy
				? await sendBatch(router.base, accountId, `restart-${step.name}`, 5)
				: { sent: 5, served: 0, failures: [] };
			restarts[step.name] = {
				startedFromLiveServer,
				routerReserveRearm,
				stopExit,
				filesAfterStop,
				...start,
				requests: served,
				exit: router.exit,
				health: healthy ? await health(router.base) : null,
				logDirExists: existsSync(dirname(logFile)),
				// The startup sweep had the seeded rows to delete. Whether the
				// delete fits is not the point; the start not depending on it is.
				retention: healthy ? await retentionOutcome(router.base) : null,
				seededRowsRemaining: healthy ? seededRowsRemaining(dbFile) : null,
			};
			const kind = startedFromLiveServer ? "restart" : "cold start";
			if (!healthy) {
				failures.push(
					`${step.name}: the ${kind} on the full filesystem failed: ${JSON.stringify(router.exit)}`,
				);
			} else if (served.served !== served.sent) {
				failures.push(
					`${step.name}: only ${served.served} of ${served.sent} requests were served after the ${kind}`,
				);
			}
			if (
				startedFromLiveServer &&
				step.signal === "SIGTERM" &&
				stopExit?.exitCode !== 0
			) {
				failures.push(
					`${step.name}: the clean stop on the full filesystem did not exit 0: ${JSON.stringify(stopExit)}`,
				);
			}
		}
		report.restarts = restarts;
		report.pidChanged = router.pid !== firstPid;

		// 4b. The same restart, repeated. Each start has to reopen the database
		// with nothing free, so a start that only works most of the time shows
		// up here as the iteration it first failed on.
		if (args.restartLoops > 0 && !router.alive() && !args.loopContinue) {
			report.restartLoop = {
				requested: args.restartLoops,
				pressure: args.pressure,
				completed: 0,
				skipped: "the restarts above left no server running",
			};
		} else if (args.restartLoops > 0) {
			const loop: Record<string, unknown> = {
				requested: args.restartLoops,
				pressure: args.pressure,
				signal: args.loopSignal,
				// Starts that worked before the first one that did not.
				completed: 0,
				firstFailure: null,
			};
			const startMs: number[] = [];
			const iterations: unknown[] = [];
			let failed = 0;
			for (let i = 0; i < args.restartLoops; i++) {
				const signal =
					args.loopSignal === "term" || i % 2 === 0 ? "SIGTERM" : "SIGKILL";
				const startedFromLiveServer = router.alive();
				const routerReserveRearm = await rearmRouterReserve();
				await router.stop(signal, 20_000);
				const stopExit = router.exit;
				const filesAfterStop = sideFiles(dbFile);
				if (signal === "SIGKILL" && args.killPauseMs > 0) {
					await Bun.sleep(args.killPauseMs);
				}
				const start = await startOnFull();
				startMs.push(start.startMs);
				const served = start.healthy
					? await sendBatch(router.base, accountId, `loop-${i}`, 2)
					: { sent: 2, served: 0, failures: [] };
				const cleanStopFailed =
					startedFromLiveServer &&
					signal === "SIGTERM" &&
					stopExit?.exitCode !== 0;
				const ok =
					start.healthy && served.served === served.sent && !cleanStopFailed;
				if (args.loopContinue) {
					iterations.push({
						iteration: i + 1,
						signal,
						startedFromLiveServer,
						ok,
						filesAfterStop,
						blocksBeforeStart: start.blocksBeforeStart,
						filesAfterStart: start.filesAfterStart,
						padRestore: start.padRestore,
						reserveBlocksReleased: start.reserveBlocksReleased,
						blocksAfterRelease: start.blocksAfterRelease,
						reserveRestore: start.reserveRestore,
						reserveRearmed: start.reserveRearmed,
						routerReserveRearm,
						routerReserveBeforeStart: start.routerReserveBeforeStart,
						routerReserveAfterStart: start.routerReserveAfterStart,
						routerReleasedReserve: start.routerReleasedReserve,
						failure: start.failure,
					});
				}
				if (ok) {
					if (failed === 0) loop.completed = i + 1;
					continue;
				}
				failed++;
				if (loop.firstFailure === null) {
					loop.firstFailure = {
						iteration: i + 1,
						signal,
						stopExit,
						filesAfterStop,
						...start,
						requests: served,
						exit: router.exit,
					};
					failures.push(
						`restart loop: iteration ${i + 1} of ${args.restartLoops} (${signal}) failed: ${JSON.stringify({ healthy: start.healthy, served: served.served, stopExit, exit: router.exit })}`,
					);
				}
				if (!args.loopContinue) break;
			}
			loop.startMs = {
				min: Math.min(...startMs),
				max: Math.max(...startMs),
			};
			if (args.loopContinue) {
				loop.failed = failed;
				loop.iterations = iterations;
				if (failed > 1) {
					failures.push(
						`restart loop: ${failed} of ${args.restartLoops} starts failed`,
					);
				}
			}
			report.restartLoop = loop;
		}

		// 5. Space returns: recording resumes without a restart.
		await stopPressure();
		let coldStartAfterSpaceReturned: boolean | null = null;
		if (!router.alive()) {
			// A failed start above left nothing running. Whether the server comes
			// back by itself once there is room is the next thing worth knowing.
			router.start();
			coldStartAfterSpaceReturned = await router.waitHealthy(60_000);
			if (!coldStartAfterSpaceReturned) {
				report.recovery = { coldStartAfterSpaceReturned };
				throw new Error("the server did not start even after space returned");
			}
		}
		const pidBeforeRecovery = router.pid;
		const recordedWhileFull = router.alive()
			? await recordedRequests(router.base)
			: null;
		const logBytesBefore = fileSize(logFile);
		const recovered = router.alive()
			? await sendBatch(router.base, accountId, "recovered", 5)
			: { sent: 5, served: 0, failures: [] };
		const resumed = router.alive()
			? await waitFor(async () => {
					const count = await recordedRequests(router.base);
					return (
						count !== null &&
						recordedWhileFull !== null &&
						count >= recordedWhileFull + recovered.sent
					);
				}, 45_000)
			: false;
		// The log file takes lines again. The sink retries on a backoff of up to
		// 30 s, and only a new line makes it try, so keep provoking one.
		const logBytesAtRecovery = fileSize(logFile) ?? 0;
		const logWaitStart = Date.now();
		const logResumed = await waitFor(async () => {
			await provokeLogLine(router.base);
			return (fileSize(logFile) ?? 0) > logBytesAtRecovery;
		}, 75_000);
		report.recovery = {
			coldStartAfterSpaceReturned,
			logResumed,
			logResumedAfterMs: logResumed ? Date.now() - logWaitStart : null,
			seededRowsRemaining: seededRowsRemaining(dbFile),
			requests: recovered,
			recordedWhileFull,
			recordedAfter: router.alive()
				? await recordedRequests(router.base)
				: null,
			recordingResumed: resumed,
			// When each recorded request was sent, oldest first: the gap is what
			// the full filesystem cost in history.
			recordedAt: router.alive()
				? ((await recordedRows(router.base)) ?? [])
						// The API sends each timestamp as an ISO string.
						.map((row) => Date.parse(String(row.timestamp)))
						.filter(Number.isFinite)
						.sort((a, b) => a - b)
						.map((at) => new Date(at).toISOString())
				: null,
			samePid: router.pid === pidBeforeRecovery && router.alive(),
			logBytesBefore,
			logBytesAfter: fileSize(logFile),
			health: router.alive() ? await health(router.base) : null,
			freeBytes: freeBytes(args.dir),
		};
		if (recovered.served !== recovered.sent) {
			failures.push(
				`only ${recovered.served} of ${recovered.sent} requests were served after space returned`,
			);
		}
		if (!resumed) {
			// After a cold start there is no "without a restart" left to claim;
			// what is checked then is only that the restarted server records.
			failures.push(
				coldStartAfterSpaceReturned === null
					? "request recording did not resume after space returned without a restart"
					: "the server started once space returned but did not record requests",
			);
		}
		if (!logResumed) {
			failures.push(
				"the log file took no new line within 75 s of space returning",
			);
		}
	} catch (error) {
		failures.push(`scenario aborted: ${String(error)}`);
	} finally {
		await stopPressure();
		await router.stop("SIGTERM", 20_000);
		await upstream.stop(true);
	}

	report.upstreamHits = upstreamHits;
	report.failures = failures;
	report.serverOutput = exitContext(router.output);
	console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
	console.error(`disk-full scenario harness error: ${String(error)}`);
	process.exit(2);
});
