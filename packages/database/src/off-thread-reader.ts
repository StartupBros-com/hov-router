import { Logger } from "@hov-router/logger";
import {
	BatchExpectedChangesError,
	type BatchStatement,
} from "./adapters/batch-statement";
import {
	fingerprintSql,
	SLOW_SQL_STATEMENT_MS,
} from "./sqlite-statement-timing";

export interface ReaderWorker {
	onmessage: ((event: MessageEvent) => void) | null;
	onerror: ((event: ErrorEvent) => void) | null;
	onmessageerror: ((event: MessageEvent) => void) | null;
	postMessage(message: unknown): void;
	terminate(): void;
	unref?(): void;
	/** Bun fires "close" once the worker's thread has really exited. */
	addEventListener?(type: "close", listener: () => void): void;
}

export interface OffThreadReaderOptions {
	dbPath: string;
	busyTimeoutMs: number;
	embeddedCode: string;
	sourceUrl: string;
	workerFactory?: (specifier: string, options?: WorkerOptions) => ReaderWorker;
	createObjectURL?: (blob: Blob) => string;
	revokeObjectURL?: (url: string) => void;
	readTimeoutMs?: number;
	readyTimeoutMs?: number;
	maxSpawns?: number;
	/**
	 * How long a reader whose spawn budget is spent fails its reads before it
	 * spawns again. Default 60 s. The writer does not use it.
	 */
	respawnCooldownMs?: number;
	/** Clock for the respawn cool-down; tests inject one. */
	now?: () => number;
	/**
	 * How many terminated workers may still be running before the reader stops
	 * spawning replacements. bun:sqlite cannot interrupt a running statement, so
	 * terminate() ends a timed-out read's thread only once its statement returns.
	 * Default 1: a lane runs at most two threads, and reads wait for an exit.
	 */
	maxOrphans?: number;
	/**
	 * How long a terminated worker counts against maxOrphans when its thread
	 * never reports an exit. Default ten read timeouts.
	 */
	orphanExpiryMs?: number;
	/** Names this worker in log lines when a process runs more than one reader. */
	label?: string;
	/** The worker's OS thread name (see DB_WORKER_THREAD_NAMES); 15 bytes at most. */
	threadName?: string;
	warn?: (message: string) => void;
	info?: (message: string) => void;
}

/**
 * The worker could not take the request, or faulted while it held it. A read
 * fails with it (#921); a write the worker never received is safe to run on
 * the main connection, and the adapter does that.
 */
export class OffThreadReaderUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OffThreadReaderUnavailableError";
	}
}

/**
 * A write reached the worker, then the worker faulted or stopped answering.
 * It may or may not have committed, so it must not be re-run anywhere. Never
 * an OffThreadReaderUnavailableError, and the message never names a SQLite
 * lock error, so neither the adapter fallback nor withDatabaseRetry repeats it.
 */
export class OffThreadWriteOutcomeUnknownError extends Error {
	constructor(cause: string) {
		super(`off-thread write outcome unknown (${cause}); not retried`);
		this.name = "OffThreadWriteOutcomeUnknownError";
	}
}

type PendingRequest = {
	mode: string;
	sql: string;
	params?: unknown[];
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
	timer?: ReturnType<typeof setTimeout>;
};
type Lease = {
	worker: ReaderWorker;
	url?: string;
	ready: Promise<void>;
	resolveReady: () => void;
	rejectReady: (error: Error) => void;
	readyTimer?: ReturnType<typeof setTimeout>;
	retireTimer?: ReturnType<typeof setTimeout>;
	resolveRetired?: () => void;
	/** The worker reports its thread's exit, so a terminated one can be counted. */
	tracksExit: boolean;
	exited?: boolean;
	/** Counted in orphans once; destroy() never counts a lease twice. */
	orphaned?: boolean;
	/** Terminated while its thread still ran; counted in orphans until it exits. */
	orphanedAt?: number;
	orphanTimer?: ReturnType<typeof setTimeout>;
};
type ErrorDetail = {
	message: string;
	name: string;
	code?: string;
	errno?: number;
	batch?: {
		statementIndex: number;
		expectedChanges: number;
		actualChanges: number;
	};
};

const loggedReady = new Set<string>();

function rehydrate(detail: ErrorDetail): Error {
	if (detail.batch)
		return new BatchExpectedChangesError(
			detail.batch.statementIndex,
			detail.batch.expectedChanges,
			detail.batch.actualChanges,
		);
	return Object.assign(new Error(detail.message), {
		name: detail.name,
		...(detail.code === undefined ? {} : { code: detail.code }),
		...(detail.errno === undefined ? {} : { errno: detail.errno }),
	});
}

/** A lazy read-only SQLite connection whose statements never run on the serving thread. */
export class OffThreadReader {
	protected lease?: Lease;
	protected readonly pending = new Map<number, PendingRequest>();
	/** Reads not yet given to the worker, oldest first. Never used by the writer. */
	private readonly waiting: PendingRequest[] = [];
	protected nextId = 0;
	protected faults = 0;
	protected closed = false;
	protected closePromise?: Promise<void>;
	protected served = 0;
	protected readonly warn: (message: string) => void;
	protected readonly info: (message: string) => void;
	protected readonly readTimeoutMs: number;
	protected readonly readyTimeoutMs: number;
	protected readonly maxSpawns: number;
	private readonly respawnCooldownMs: number;
	private readonly now: () => number;
	/** When the last spawn in the budget faulted; cleared by any worker result. */
	private budgetSpentAt?: number;
	/** Terminated workers whose threads have not exited yet. */
	protected orphans = 0;
	private readonly maxOrphans: number;
	private readonly orphanExpiryMs: number;
	private holding = false;

	constructor(protected readonly options: OffThreadReaderOptions) {
		const log = new Logger("OffThreadSql");
		this.warn = options.warn ?? ((message) => log.warn(message));
		this.info = options.info ?? ((message) => log.info(message));
		this.readTimeoutMs = options.readTimeoutMs ?? 120_000;
		this.readyTimeoutMs = options.readyTimeoutMs ?? 10_000;
		this.maxSpawns = options.maxSpawns ?? 3;
		this.respawnCooldownMs = options.respawnCooldownMs ?? 60_000;
		this.now = options.now ?? Date.now;
		this.maxOrphans = options.maxOrphans ?? 1;
		this.orphanExpiryMs = options.orphanExpiryMs ?? this.readTimeoutMs * 10;
	}

	protected get label(): string {
		return this.options.label ?? "reader";
	}

	get readsServed(): number {
		return this.served;
	}

	all<R>(sql: string, params: unknown[] = []): Promise<R[]> {
		return this.read("all", sql, params) as Promise<R[]>;
	}
	get<R>(sql: string, params: unknown[] = []): Promise<R | null> {
		return this.read("get", sql, params) as Promise<R | null>;
	}

	private async read(
		mode: "all" | "get",
		sql: string,
		params: unknown[],
	): Promise<unknown> {
		if (this.closed)
			throw new OffThreadReaderUnavailableError("off-thread reader closed");
		if (this.faults >= this.maxSpawns && !this.cooledDown())
			throw new OffThreadReaderUnavailableError(
				`off-thread ${this.label} spawn budget spent; it respawns after a ${this.respawnCooldownMs}ms cool-down`,
			);
		// While too many terminated workers still run, the read waits for one to
		// exit (orphanExited resumes it) or sheds at its timeout.
		const lease = this.lease ?? (this.spawnHeld() ? undefined : this.spawn());
		if (lease) {
			await lease.ready;
			if (this.closed || this.lease !== lease)
				throw new OffThreadReaderUnavailableError(
					"off-thread reader unavailable",
				);
		}
		return new Promise((resolve, reject) => {
			const request: PendingRequest = { mode, sql, params, resolve, reject };
			request.timer = setTimeout(() => this.shed(request), this.readTimeoutMs);
			this.waiting.push(request);
			if (lease) this.pump(lease);
		});
	}

	/**
	 * The worker runs reads one at a time, so it is given one at a time and the
	 * rest wait here (#709). A read's timeout then measures its own run, a read
	 * that waits too long can give up without touching the worker, and the reads
	 * waiting when the worker faults never reached it and can go to a fresh one.
	 */
	private pump(lease: Lease): void {
		while (this.pending.size === 0 && this.lease === lease && !this.closed) {
			const request = this.waiting.shift();
			if (!request) return;
			clearTimeout(request.timer);
			const id = ++this.nextId;
			try {
				lease.worker.postMessage({
					kind: "read",
					id,
					mode: request.mode,
					sql: request.sql,
					params: request.params,
				});
			} catch (error) {
				// Not cloneable, so the worker never saw it: fail only this read.
				request.reject(
					new OffThreadReaderUnavailableError(
						`off-thread ${this.label} could not take the read: ${error instanceof Error ? error.message : String(error)}`,
					),
				);
				continue;
			}
			this.pending.set(id, request);
			request.timer = setTimeout(() => {
				this.pending.delete(id);
				const error = new Error(
					`off-thread read timed out after ${this.readTimeoutMs}ms: ${fingerprintSql(request.sql)}`,
				);
				request.reject(error);
				this.fault("read timeout", error, lease);
			}, this.readTimeoutMs);
		}
	}

	/**
	 * A read that waited its whole timeout behind others fails on its own. Not
	 * unavailable, so it is not re-run on the main thread, which would block
	 * the serving thread for as long as the worker is behind.
	 */
	private shed(request: PendingRequest): void {
		const index = this.waiting.indexOf(request);
		if (index === -1) return;
		this.waiting.splice(index, 1);
		const error = new Error(
			`off-thread ${this.label} busy: read waited ${this.readTimeoutMs}ms: ${fingerprintSql(request.sql)}`,
		);
		this.warn(error.message);
		request.reject(error);
	}

	/**
	 * After a fault, take the reads that were waiting to a fresh worker. Past
	 * the spawn budget they fail as unavailable, as new reads do until the
	 * cool-down ends. No read moves to the main thread (#921).
	 */
	private resume(): void {
		if (this.closed || this.waiting.length === 0) return;
		if (this.faults >= this.maxSpawns) {
			this.rejectWaiting(
				new OffThreadReaderUnavailableError(
					`off-thread ${this.label} spawn budget spent`,
				),
			);
			return;
		}
		// An orphan's exit resumes them.
		if (!this.lease && this.spawnHeld()) return;
		let lease: Lease;
		try {
			lease = this.lease ?? this.spawn();
		} catch {
			// spawn() counted the fault; try again or give up on the budget.
			this.resume();
			return;
		}
		// A failed open faults this lease, and that fault resumes again.
		lease.ready.then(
			() => this.pump(lease),
			() => {},
		);
	}

	/**
	 * Once the cool-down after a spent budget has passed, allow one more spawn.
	 * A result from it restores the whole budget; a fault spends it again.
	 */
	private cooledDown(): boolean {
		if (
			this.budgetSpentAt === undefined ||
			this.now() - this.budgetSpentAt < this.respawnCooldownMs
		)
			return false;
		this.budgetSpentAt = undefined;
		this.faults = this.maxSpawns - 1;
		return true;
	}

	/**
	 * True while more than maxOrphans terminated workers still run their
	 * statements. Spawning another would only add a thread, and its IO, to a
	 * lane that is already behind; warned once per hold.
	 */
	private spawnHeld(): boolean {
		if (this.orphans <= this.maxOrphans) {
			this.holding = false;
			return false;
		}
		if (!this.holding) {
			this.holding = true;
			this.warn(
				`off-thread ${this.label} holds new workers: ${this.orphans} terminated workers are still running reads that timed out; reads wait until one exits`,
			);
		}
		return true;
	}

	/** A terminated worker's thread exited, or it stopped being counted. */
	private orphanExited(lease: Lease, exited: boolean): void {
		if (lease.orphanedAt === undefined) return;
		const ms = Math.round(this.now() - lease.orphanedAt);
		lease.orphanedAt = undefined;
		clearTimeout(lease.orphanTimer);
		this.orphans--;
		this.warn(
			exited
				? `off-thread ${this.label} terminated worker exited after ${ms}ms`
				: `off-thread ${this.label} terminated worker still running after ${ms}ms; no longer counted against maxOrphans`,
		);
		this.resume();
	}

	private rejectWaiting(error: Error): void {
		for (const request of this.waiting.splice(0)) {
			clearTimeout(request.timer);
			request.reject(error);
		}
	}

	protected openPayload(): Record<string, unknown> {
		return {
			kind: "open",
			dbPath: this.options.dbPath,
			busyTimeoutMs: this.options.busyTimeoutMs,
		};
	}

	protected spawn(): Lease {
		let url: string | undefined;
		let worker: ReaderWorker;
		try {
			if (this.options.embeddedCode) {
				url = (this.options.createObjectURL ?? URL.createObjectURL)(
					new Blob(
						[Buffer.from(this.options.embeddedCode, "base64").toString("utf8")],
						{ type: "text/javascript" },
					),
				);
			}
			const { threadName } = this.options;
			worker = (
				this.options.workerFactory ??
				((specifier, options) => new Worker(specifier, options))
			)(
				url ?? this.options.sourceUrl,
				threadName ? { smol: true, name: threadName } : { smol: true },
			);
		} catch (error) {
			if (url) this.revoke(url);
			throw this.fault("spawn failed", error);
		}
		let resolveReady!: () => void;
		let rejectReady!: (error: Error) => void;
		const ready = new Promise<void>((resolve, reject) => {
			resolveReady = resolve;
			rejectReady = reject;
		});
		const lease: Lease = {
			worker,
			url,
			ready,
			resolveReady,
			rejectReady,
			tracksExit: typeof worker.addEventListener === "function",
		};
		this.lease = lease;
		worker.addEventListener?.("close", () => {
			lease.exited = true;
			this.orphanExited(lease, true);
		});
		worker.onmessage = (event) => this.receive(lease, event.data);
		worker.onerror = (event) => {
			event.preventDefault?.();
			this.fault("worker error", event.message, lease);
		};
		worker.onmessageerror = () => {
			this.fault(
				"worker messageerror",
				"could not deserialize worker message",
				lease,
			);
		};
		lease.readyTimer = setTimeout(
			() =>
				this.fault(
					"ready timeout",
					`not ready after ${this.readyTimeoutMs}ms`,
					lease,
				),
			this.readyTimeoutMs,
		);
		try {
			worker.unref?.();
			worker.postMessage(this.openPayload());
		} catch (error) {
			this.fault("open postMessage failed", error, lease);
		}
		return lease;
	}

	private receive(lease: Lease, message: Record<string, unknown>): void {
		if (this.lease !== lease || !message) return;
		if (message.kind === "retired") {
			lease.resolveRetired?.();
			return;
		}
		if (this.closed) return;
		if (message.kind === "ready") {
			clearTimeout(lease.readyTimer);
			lease.resolveReady();
			for (const warning of (message.warnings as string[] | undefined) ?? [])
				this.warn(`off-thread ${this.label} setting not applied: ${warning}`);
			if (!loggedReady.has(this.label)) {
				loggedReady.add(this.label);
				this.info(
					`Off-thread ${this.label} ready (${lease.url ? "embedded" : "source"} worker)`,
				);
			}
			return;
		}
		if (message.kind === "open-failed") {
			this.fault("open-failed", message.error, lease);
			return;
		}
		if (message.kind !== "result") return;
		const request = this.pending.get(message.id as number);
		if (!request) return;
		this.pending.delete(message.id as number);
		clearTimeout(request.timer);
		if (Number(message.ms) >= SLOW_SQL_STATEMENT_MS)
			this.warn(
				`Slow off-thread SQL: ${Math.round(Number(message.ms))}ms ${request.mode} ${fingerprintSql(request.sql)}${this.options.label ? ` (${this.options.label})` : ""}`,
			);
		this.settle(lease, request, message);
	}

	protected settle(
		lease: Lease,
		read: PendingRequest,
		message: Record<string, unknown>,
	): void {
		// Any result means the worker is alive, so it earns back its spawn budget,
		// as the writer's does. A slow read that timed out is not a dead worker.
		this.faults = 0;
		this.budgetSpentAt = undefined;
		this.pump(lease);
		if (message.ok) {
			this.served++;
			read.resolve(read.mode === "all" ? message.rows : (message.row ?? null));
			return;
		}
		const detail = message.error as ErrorDetail;
		// SQLITE_BUSY keeps its code; the adapter waits and retries it on the reader.
		read.reject(
			rehydrate({
				message: detail.message,
				name: detail.name,
				code: detail.code,
			}),
		);
	}

	/** What a request that already reached the worker is rejected with on a fault. */
	protected pendingFaultError(
		_cause: string,
		unavailable: OffThreadReaderUnavailableError,
	): Error {
		return unavailable;
	}

	protected fault(
		cause: string,
		error: unknown,
		lease?: Lease,
	): OffThreadReaderUnavailableError {
		const unavailable = new OffThreadReaderUnavailableError(
			`off-thread ${this.label} ${cause}: ${error instanceof Error ? error.message : String(error)}`,
		);
		if (lease && this.lease !== lease) return unavailable;
		this.warn(unavailable.message);
		this.faults++;
		if (lease) {
			lease.rejectReady(unavailable);
			this.rejectPending(this.pendingFaultError(cause, unavailable));
			this.destroy(lease);
		}
		if (this.faults === this.maxSpawns) this.budgetSpent();
		if (lease) this.resume();
		return unavailable;
	}

	/** The last spawn in the budget faulted. */
	protected budgetSpent(): void {
		this.budgetSpentAt = this.now();
		this.warn(
			`off-thread ${this.label} spawn budget spent; its reads fail for ${Math.round(this.respawnCooldownMs / 1000)}s, then it respawns (HOV_ROUTER_DB_READER_WORKER=0 reads on the main thread instead)`,
		);
	}

	protected rejectPending(error: Error): void {
		for (const request of this.pending.values()) {
			clearTimeout(request.timer);
			request.reject(error);
		}
		this.pending.clear();
	}
	private revoke(url: string): void {
		(this.options.revokeObjectURL ?? URL.revokeObjectURL)(url);
	}
	private destroy(lease: Lease): void {
		clearTimeout(lease.readyTimer);
		clearTimeout(lease.retireTimer);
		lease.worker.onmessage = null;
		lease.worker.onerror = null;
		lease.worker.onmessageerror = null;
		if (lease.tracksExit && !lease.exited && !lease.orphaned && !this.closed) {
			// Counted once, until its thread exits. One past orphanExpiryMs stops
			// counting, so a lost exit event cannot hold the lane for good.
			lease.orphaned = true;
			lease.orphanedAt = this.now();
			this.orphans++;
			lease.orphanTimer = setTimeout(
				() => this.orphanExited(lease, false),
				this.orphanExpiryMs,
			);
			(lease.orphanTimer as { unref?: () => void }).unref?.();
		}
		lease.worker.terminate();
		if (lease.url) this.revoke(lease.url);
		if (this.lease === lease) this.lease = undefined;
		lease.resolveRetired?.();
	}

	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closed = true;
		const error = new OffThreadReaderUnavailableError(
			`off-thread ${this.label} closed`,
		);
		this.rejectWaiting(error);
		this.rejectPending(error);
		this.closePromise = this.retire(error);
		return this.closePromise;
	}

	protected retire(error: Error): Promise<void> {
		const lease = this.lease;
		if (!lease) return Promise.resolve();
		clearTimeout(lease.readyTimer);
		lease.rejectReady(error);
		return new Promise<void>((resolve) => {
			lease.resolveRetired = resolve;
			lease.retireTimer = setTimeout(resolve, 1000);
			try {
				lease.worker.postMessage({ kind: "retire" });
			} catch {
				resolve();
			}
		}).then(() => this.destroy(lease));
	}
}

export interface WorkerPragma {
	sql: string;
	bestEffort?: boolean;
}

export interface OffThreadWriterOptions
	extends Omit<OffThreadReaderOptions, "readTimeoutMs" | "label"> {
	/** Per-connection PRAGMAs, in order; the main connection's own settings. */
	pragmas: WorkerPragma[];
	/** How long the worker keeps retrying one SQLITE_BUSY write. Default 10 min. */
	busyRetryMs?: number;
	/** Fault the worker after this long with writes pending and none settling. */
	writeTimeoutMs?: number;
	/** Bound on the drain at close before pending writes become outcome-unknown. */
	closeDrainMs?: number;
}

/**
 * The single writer connection, on its own thread (#676). Writes are posted in
 * call order and the worker runs them one at a time, so they commit in that
 * order. A write the worker never received rejects with
 * OffThreadReaderUnavailableError and is safe to run elsewhere; once posted,
 * a fault rejects it with OffThreadWriteOutcomeUnknownError instead.
 */
export class OffThreadWriter extends OffThreadReader {
	private watchdog?: ReturnType<typeof setTimeout>;
	private readonly busyRetryMs: number;
	private readonly writeTimeoutMs: number;
	private readonly closeDrainMs: number;
	private closeRequested = false;

	constructor(private readonly writerOptions: OffThreadWriterOptions) {
		super(writerOptions);
		this.busyRetryMs = writerOptions.busyRetryMs ?? 10 * 60_000;
		this.writeTimeoutMs =
			writerOptions.writeTimeoutMs ?? this.busyRetryMs + 60_000;
		this.closeDrainMs = writerOptions.closeDrainMs ?? 5_000;
	}

	protected override get label(): string {
		return "writer";
	}
	/** Writes keep their fallback: the adapter runs them on the main connection. */
	protected override budgetSpent(): void {
		this.warn(
			"falling back to main-thread writes for the rest of this process",
		);
	}

	get writesServed(): number {
		return this.served;
	}

	/** Run one statement; resolves with the outer statement's changes(). */
	run(sql: string, params: unknown[] = []): Promise<number> {
		return this.write("run", sql, params) as Promise<number>;
	}
	/** Run one statement and return its first row (INSERT ... RETURNING). */
	runGet<R>(sql: string, params: unknown[] = []): Promise<R | null> {
		return this.write("get", sql, params) as Promise<R | null>;
	}
	/** Run statements in one transaction; resolves with each one's changes(). */
	batch(statements: BatchStatement[]): Promise<number[]> {
		return this.write(
			"batch",
			statements[0]?.sql ?? "",
			[],
			statements,
		) as Promise<number[]>;
	}

	protected override openPayload(): Record<string, unknown> {
		return {
			...super.openPayload(),
			access: "write",
			pragmas: this.writerOptions.pragmas,
			busyRetryMs: this.busyRetryMs,
		};
	}

	private async write(
		mode: "run" | "get" | "batch",
		sql: string,
		params: unknown[],
		statements?: BatchStatement[],
	): Promise<unknown> {
		while (true) {
			if (this.closeRequested) {
				// Earlier writes are draining; let them commit before this one runs
				// anywhere else, so the caller's fallback keeps submission order.
				await this.close();
				throw new OffThreadReaderUnavailableError("off-thread writer closed");
			}
			if (this.faults >= this.maxSpawns)
				throw new OffThreadReaderUnavailableError(
					"off-thread writer spawn budget exhausted",
				);
			let lease: Lease;
			try {
				lease = this.lease ?? this.spawn();
				await lease.ready;
			} catch {
				// fault() counted it; retry until the spawn budget runs out.
				continue;
			}
			if (this.closeRequested || this.lease !== lease) continue;
			return this.post(lease, mode, sql, params, statements);
		}
	}

	private post(
		lease: Lease,
		mode: "run" | "get" | "batch",
		sql: string,
		params: unknown[],
		statements?: BatchStatement[],
	): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const id = ++this.nextId;
			try {
				lease.worker.postMessage({
					kind: "write",
					id,
					mode,
					sql,
					params,
					...(statements ? { statements } : {}),
				});
			} catch (error) {
				// Not cloneable, so the worker never saw it: fail only this request.
				reject(error instanceof Error ? error : new Error(String(error)));
				return;
			}
			this.pending.set(id, { mode, sql, resolve, reject });
			if (!this.watchdog) this.armWatchdog(lease);
		});
	}

	private armWatchdog(lease: Lease): void {
		clearTimeout(this.watchdog);
		this.watchdog = setTimeout(() => {
			this.watchdog = undefined;
			this.fault(
				"write timeout",
				`no write settled for ${this.writeTimeoutMs}ms`,
				lease,
			);
		}, this.writeTimeoutMs);
		(this.watchdog as { unref?: () => void }).unref?.();
	}
	private clearWatchdog(): void {
		clearTimeout(this.watchdog);
		this.watchdog = undefined;
	}

	protected override settle(
		lease: Lease,
		request: PendingRequest,
		message: Record<string, unknown>,
	): void {
		// Progress: a live worker earns back its spawn budget.
		this.faults = 0;
		if (this.pending.size > 0) this.armWatchdog(lease);
		else this.clearWatchdog();
		if (message.ok) {
			this.served++;
			request.resolve(message.value ?? null);
		} else {
			request.reject(rehydrate(message.error as ErrorDetail));
		}
		this.notifyIdle();
	}

	protected override pendingFaultError(cause: string): Error {
		return new OffThreadWriteOutcomeUnknownError(cause);
	}

	protected override rejectPending(error: Error): void {
		this.clearWatchdog();
		super.rejectPending(error);
		this.notifyIdle();
	}

	private idle?: { promise: Promise<void>; resolve: () => void };
	private whenIdle(): Promise<void> {
		if (this.pending.size === 0) return Promise.resolve();
		if (!this.idle) {
			let resolve!: () => void;
			const promise = new Promise<void>((done) => {
				resolve = done;
			});
			this.idle = { promise, resolve };
		}
		return this.idle.promise;
	}
	private notifyIdle(): void {
		if (this.pending.size > 0 || !this.idle) return;
		this.idle.resolve();
		this.idle = undefined;
	}

	/** Stop taking writes, let posted ones finish (bounded), then retire. */
	override close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closeRequested = true;
		this.closePromise = this.drain().then(() => {
			this.closed = true;
			this.rejectPending(
				new OffThreadWriteOutcomeUnknownError("writer closed during drain"),
			);
			return this.retire(
				new OffThreadReaderUnavailableError("off-thread writer closed"),
			);
		});
		return this.closePromise;
	}

	private async drain(): Promise<void> {
		const lease = this.lease;
		if (!lease || this.pending.size === 0) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timedOut = new Promise<boolean>((resolve) => {
			timer = setTimeout(() => resolve(true), this.closeDrainMs);
		});
		const expired = await Promise.race([
			this.whenIdle().then(() => false),
			timedOut,
		]);
		clearTimeout(timer);
		if (expired)
			this.fault(
				"close drain timeout",
				`${this.pending.size} write(s) still pending after ${this.closeDrainMs}ms`,
				lease,
			);
	}
}
