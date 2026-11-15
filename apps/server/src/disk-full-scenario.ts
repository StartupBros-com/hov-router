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
 *     [--wal-frames <n>]
 *
 * `--restart-loops` repeats the restart on the full filesystem, alternating a
 * clean stop and a kill, and stops at the first start that fails. `--pressure
 * spin` adds a second process that retries a 4 KiB append, so a block the
 * router releases even for microseconds can be taken; `--spin-pause-us` sets
 * the pause between its attempts (default 0, which no start survives: SQLite
 * releases and retakes the WAL index's pages when it opens the database).
 * `--wal-frames` leaves that many frames in the write-ahead log before the
 * fill; above 4,062 the index a start rebuilds no longer fits one 32 KiB
 * region.
 *
 * Prints one JSON report on stdout. Exit 0 means the scenario ran (read
 * `failures`); exit 2 means the harness itself could not run.
 */
import { Database } from "bun:sqlite";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	rmSync,
	statfsSync,
	statSync,
	writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

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
}

function parseArgs(argv: string[]): Args {
	let dir = "";
	let binary: string | null = null;
	let soakMs = 20_000;
	let baselineOnly = false;
	let restartLoops = 0;
	let pressure: Args["pressure"] = "timer";
	let spinPauseUs = 0;
	let walFrames = 0;
	for (let i = 0; i < argv.length; i++) {
		const value = argv[i + 1];
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
	return {
		dir: resolve(dir),
		binary,
		soakMs,
		baselineOnly,
		restartLoops,
		pressure,
		spinPauseUs,
		walFrames,
	};
}

function freeBytes(dir: string): number {
	const stats = statfsSync(dir);
	return Number(stats.bavail) * Number(stats.bsize);
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
 */
function seedLargeWal(dbFile: string, frames: number): number | null {
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
	};
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
		const seededBootRows = seedBootWork(dbFile);
		const walBytesSeeded =
			args.walFrames > 0 ? seedLargeWal(dbFile, args.walFrames) : null;
		report.seed = {
			rows: seededBootRows,
			retentionWithSpace,
			walFrames: args.walFrames,
			walBytesSeeded,
		};

		// 2. Fill the filesystem and keep it full.
		const filledBytes = fillToZero(ballast);
		refill = setInterval(() => {
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
			(report.seed as Record<string, unknown>).walBytesAtFill = walBytesAtFill;
			if (walBytesAtFill < args.walFrames * PAGE_BYTES) {
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
		const steps = [
			{ name: "clean-stop", signal: "SIGTERM", removeLogDir: false },
			{ name: "crash", signal: "SIGKILL", removeLogDir: false },
			{ name: "clean-stop-no-log-dir", signal: "SIGTERM", removeLogDir: true },
		] as const;
		for (const step of steps) {
			const startedFromLiveServer = router.alive();
			await router.stop(step.signal, 20_000);
			const stopExit = router.exit;
			const filesAfterStop = sideFiles(dbFile);
			if (step.removeLogDir) {
				rmSync(dirname(logFile), { recursive: true, force: true });
			}
			// Whatever the stop released goes back to the co-tenant before the start.
			fillToZero(ballast);
			const freeBeforeStart = freeBytes(args.dir);
			router.start();
			const healthy = await router.waitHealthy(60_000);
			const served = healthy
				? await sendBatch(router.base, accountId, `restart-${step.name}`, 5)
				: { sent: 5, served: 0, failures: [] };
			restarts[step.name] = {
				startedFromLiveServer,
				stopExit,
				filesAfterStop,
				freeBeforeStart,
				healthy,
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
		if (args.restartLoops > 0 && !router.alive()) {
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
				completed: 0,
				firstFailure: null,
			};
			const startMs: number[] = [];
			for (let i = 0; i < args.restartLoops; i++) {
				const signal = i % 2 === 0 ? "SIGTERM" : "SIGKILL";
				await router.stop(signal, 20_000);
				const stopExit = router.exit;
				const filesAfterStop = sideFiles(dbFile);
				fillToZero(ballast);
				const freeBeforeStart = freeBytes(args.dir);
				const startedAt = Date.now();
				router.start();
				const healthy = await router.waitHealthy(60_000);
				startMs.push(Date.now() - startedAt);
				const served = healthy
					? await sendBatch(router.base, accountId, `loop-${i}`, 2)
					: { sent: 2, served: 0, failures: [] };
				const cleanStopFailed =
					signal === "SIGTERM" && stopExit?.exitCode !== 0;
				if (!healthy || served.served !== served.sent || cleanStopFailed) {
					loop.firstFailure = {
						iteration: i + 1,
						signal,
						stopExit,
						filesAfterStop,
						filesAfterStart: sideFiles(dbFile),
						freeBeforeStart,
						healthy,
						requests: served,
						exit: router.exit,
					};
					failures.push(
						`restart loop: iteration ${i + 1} of ${args.restartLoops} (${signal}) failed: ${JSON.stringify({ healthy, served: served.served, stopExit, exit: router.exit })}`,
					);
					break;
				}
				loop.completed = i + 1;
			}
			loop.startMs = {
				min: Math.min(...startMs),
				max: Math.max(...startMs),
			};
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
