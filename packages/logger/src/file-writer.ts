import {
	createWriteStream,
	existsSync,
	mkdirSync,
	statSync,
	truncateSync,
	unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogEvent } from "@hov-router/types";

// Local constants to avoid circular dependency with core
const BUFFER_SIZES = {
	LOG_FILE_MAX_SIZE: 10 * 1024 * 1024, // 10MB
} as const;

const LIMITS = {
	LOG_MESSAGE_MAX_LENGTH: 10000,
	LOG_READ_DEFAULT: 1000,
} as const;

// Simple disposable interface to avoid circular dependency
interface Disposable {
	dispose(): void;
}

const disposables = new Set<Disposable>();

function registerDisposable(disposable: Disposable): void {
	disposables.add(disposable);
}

// String(e) can itself throw (e.g. an object with a throwing
// Symbol.toPrimitive, or Object.create(null)), which would defeat the
// purpose of the catch block calling this. Never let this throw.
function safeErrorReason(e: unknown): string {
	if (e instanceof Error) return e.message;
	try {
		return String(e);
	} catch {
		return "unknown error";
	}
}

const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

// The error's code (`ENOSPC`), else its name, and never its message, which
// names the log file's path. Same rule as `errorKind` in core, which this
// package cannot import. Never throws.
function safeErrorKind(e: unknown): string {
	if (typeof e !== "object" || e === null) return "unknown";
	try {
		const { code, name } = e as { code?: unknown; name?: unknown };
		if (typeof code === "string" && ERROR_CODE.test(code)) return code;
		if (typeof name === "string" && ERROR_NAME.test(name)) return name;
		return "Error";
	} catch {
		return "unknown";
	}
}

/** How the file sink is doing; surfaced on `/health` so dropped logs are visible. */
export interface LogFileSinkStatus {
	/** True while lines are being dropped because the log file cannot be written. */
	suspended: boolean;
	/**
	 * Lines lost since the sink last worked: those dropped while it was
	 * suspended, and those already handed to the file when its write failed.
	 * Resets when it resumes.
	 */
	dropped: number;
	/** How many times the sink has failed since the process started. */
	failures: number;
	/**
	 * The last failure's error code (`ENOSPC`), or its name when it has no
	 * code. Not the message: `/health` needs no API key, and the message names
	 * the log file's path. The message goes to stderr.
	 */
	lastError: string | null;
	lastErrorAt: number | null;
}

export interface LogFileWriterOptions {
	/** First delay before the sink tries to reopen its file; doubles up to the cap. */
	retryBaseMs?: number;
	/** How long the sink must work after a resume before the delay starts over. */
	retryResetAfterMs?: number;
	/** Replaces the clock in tests. */
	now?: () => number;
}

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30_000;
const RETRY_RESET_AFTER_MS = 60_000;

/**
 * Appends log events to `app.log`.
 *
 * The file is a convenience copy (the dashboard's log history reads it), so a
 * log file that cannot be written must never cost more than the log lines
 * themselves. A full disk used to end the whole process here: the write
 * stream had no `error` listener, so its first ENOSPC surfaced as an uncaught
 * exception. Now any failure suspends the sink, drops lines while suspended,
 * and reopens the file with backoff. Nothing in this class throws.
 */
export class LogFileWriter implements Disposable {
	private logDir: string;
	private logFile: string;
	private stream: ReturnType<typeof createWriteStream> | null = null;
	private maxFileSize = BUFFER_SIZES.LOG_FILE_MAX_SIZE;
	private writeCount = 0;
	private static readonly SIZE_CHECK_INTERVAL = 100;
	private readonly retryBaseMs: number;
	private readonly retryResetAfterMs: number;
	private readonly now: () => number;
	private retryDelayMs: number;
	private suspendedUntil: number | null = null;
	/** When the sink last resumed; null until it has, and again once it fails. */
	private resumedAt: number | null = null;
	/**
	 * Lines handed to the file that it has not confirmed writing. Replaced,
	 * not zeroed, when a stream fails: an answer that arrives later for a line
	 * of the failed stream changes the old object and not the new count.
	 */
	private unconfirmed = { lines: 0 };
	private dropped = 0;
	private failures = 0;
	private lastError: string | null = null;
	private lastErrorKind: string | null = null;
	private lastErrorAt: number | null = null;

	constructor(options: LogFileWriterOptions = {}) {
		this.retryBaseMs = options.retryBaseMs ?? RETRY_BASE_MS;
		this.retryResetAfterMs = options.retryResetAfterMs ?? RETRY_RESET_AFTER_MS;
		this.now = options.now ?? Date.now;
		this.retryDelayMs = this.retryBaseMs;
		// Use environment variable if set, otherwise use tmp folder
		this.logDir =
			process.env.HOV_ROUTER_LOG_DIR || join(tmpdir(), "hov-router-logs");
		this.logFile = join(this.logDir, "app.log");
		this.initStream();
	}

	status(): LogFileSinkStatus {
		return {
			suspended: this.suspendedUntil !== null,
			dropped: this.dropped,
			failures: this.failures,
			lastError: this.lastErrorKind,
			lastErrorAt: this.lastErrorAt,
		};
	}

	/**
	 * Stop writing until the backoff passes. The one stderr line per failure is
	 * the only notice: routing it through the logger would call back into the
	 * sink that just failed.
	 */
	private suspend(error: unknown): void {
		const stream = this.stream;
		this.stream = null;
		// A write is answered some time after the line is handed over, so a
		// burst can be on its way when the first of them fails. Those lines go
		// down with the stream and are lost as surely as the ones dropped
		// afterwards.
		this.dropped += this.unconfirmed.lines;
		this.unconfirmed = { lines: 0 };
		try {
			stream?.destroy();
		} catch {
			// The stream is already unusable.
		}
		const now = this.now();
		// A disk that is still full lets the odd write through. One such
		// write must not bring the delay back to its base, or the sink would
		// retry, and say so on stderr, every second for as long as the disk
		// stays full. The delay starts over only once the sink has worked for
		// a while since it last resumed.
		if (
			this.resumedAt !== null &&
			now - this.resumedAt >= this.retryResetAfterMs
		) {
			this.retryDelayMs = this.retryBaseMs;
		}
		this.resumedAt = null;
		this.failures++;
		this.lastError = safeErrorReason(error);
		this.lastErrorKind = safeErrorKind(error);
		this.lastErrorAt = now;
		this.suspendedUntil = now + this.retryDelayMs;
		this.retryDelayMs = Math.min(this.retryDelayMs * 2, RETRY_MAX_MS);
		try {
			console.error(
				`[logger] log file ${this.logFile} is not writable (${this.lastError}); dropping file log lines and retrying`,
			);
		} catch {
			// stderr can be unwritable for the same reason the file is.
		}
	}

	private initStream(): void {
		try {
			// Close existing stream if any
			if (this.stream && !this.stream.destroyed) {
				this.stream.end();
				this.stream = null;
			}

			if (!existsSync(this.logDir)) {
				mkdirSync(this.logDir, { recursive: true });
			}

			// Check if we need to rotate
			if (existsSync(this.logFile)) {
				const stats = statSync(this.logFile);
				if (stats.size > this.maxFileSize) {
					this.rotateLog();
				}
			}

			// Create write stream with append mode. Open and write failures arrive
			// as `error` events; without a listener they are uncaught exceptions.
			const stream = createWriteStream(this.logFile, { flags: "a" });
			stream.on("error", (error) => {
				if (this.stream === stream) this.suspend(error);
			});
			this.stream = stream;
		} catch (error) {
			this.suspend(error);
		}
	}

	private rotateLog(): void {
		if (this.stream) {
			this.stream.end();
			this.stream = null;
		}

		if (existsSync(this.logFile)) {
			try {
				unlinkSync(this.logFile);
			} catch (e: unknown) {
				const code = (e as NodeJS.ErrnoException).code;
				if (code === "EACCES" || code === "EPERM") {
					// Fallback: try truncating the file instead
					try {
						truncateSync(this.logFile, 0);
					} catch (truncErr) {
						console.error(
							"Log rotation fallback to truncate failed, switching to new file:",
							truncErr,
						);
						// Last resort: switch to a timestamped log file
						this.logFile = join(this.logDir, `app-${Date.now()}.log`);
					}
				} else {
					console.error("Failed to rotate log:", e);
				}
			}
		}
	}

	write(event: LogEvent): void {
		try {
			this.writeEvent(event);
		} catch (error) {
			// A logging call must never crash its caller.
			this.dropped++;
			this.suspend(error);
		}
	}

	private writeEvent(event: LogEvent): void {
		if (this.suspendedUntil !== null) {
			const now = this.now();
			if (now < this.suspendedUntil) {
				// With a stream open, a reopen is being tried and this line
				// joins it. With none, the sink is waiting out its delay.
				if (!this.stream) {
					this.dropped++;
					return;
				}
			} else {
				this.initStream();
				if (!this.stream) {
					this.dropped++;
					return;
				}
				// Reopened. Whether the file is writable again is only known
				// once a write completes, so the notice is the first line of
				// the attempt. The next attempt is put off by the current
				// delay: lines that arrive before the notice's write answers
				// go to this stream, instead of each opening another and
				// writing the notice again. If that write never answers, the
				// delay runs out and the file is opened afresh.
				this.suspendedUntil = now + this.retryDelayMs;
				const resumed: LogEvent = {
					ts: Date.now(),
					level: "WARN",
					msg: `Log file sink resumed after dropping ${this.dropped} line(s): ${this.lastError ?? "unknown error"}`,
				};
				const stream = this.stream;
				stream.write(`${JSON.stringify(resumed)}\n`, (error) => {
					if (error || this.stream !== stream) return;
					this.suspendedUntil = null;
					this.dropped = 0;
					this.resumedAt = this.now();
				});
			}
		} else if (!this.stream || this.stream.destroyed) {
			this.initStream();
		}

		// Periodic size check to trigger rotation mid-stream (every N writes)
		if (++this.writeCount % LogFileWriter.SIZE_CHECK_INTERVAL === 0) {
			try {
				if (existsSync(this.logFile)) {
					const stats = statSync(this.logFile);
					if (stats.size > this.maxFileSize) {
						this.rotateLog();
						this.initStream();
					}
				}
			} catch {
				// Ignore stat errors, will be caught on next initStream
			}
		}

		let line: string;
		try {
			line = `${JSON.stringify(event)}\n`;
		} catch (e: unknown) {
			// event.data comes from caller-supplied log payloads and may contain
			// circular references or BigInt values, both of which make
			// JSON.stringify throw. A logging call must never crash its caller,
			// so fall back to a sanitized line that preserves ts/level/msg and
			// replaces only the offending data field.
			const reason = safeErrorReason(e);
			const fallback: LogEvent = {
				ts: event.ts,
				level: event.level,
				msg: event.msg,
				data: `[unserializable: ${reason}]`,
			};
			line = `${JSON.stringify(fallback)}\n`;
		}
		if (this.stream) {
			const unconfirmed = this.unconfirmed;
			this.stream.write(line, (error) => {
				// Only a write that worked takes its line off the count. A
				// failed one stays on it until the stream's failure is handled.
				if (!error) unconfirmed.lines--;
			});
			// After the call, so a line whose write throws is counted once, by
			// the caller's catch.
			unconfirmed.lines++;
		} else {
			this.dropped++;
		}
	}

	async readLogs(limit: number = LIMITS.LOG_READ_DEFAULT): Promise<LogEvent[]> {
		if (!existsSync(this.logFile)) {
			return [];
		}

		try {
			const lines = await this.readTailLines(limit);

			// Return the last N logs
			return lines
				.slice(-limit)
				.map((line) => {
					try {
						return JSON.parse(line);
					} catch {
						return null;
					}
				})
				.filter((log): log is LogEvent => log !== null);
		} catch (_e) {
			console.error("Failed to read logs:", _e);
			return [];
		}
	}

	private async readTailLines(limit: number): Promise<string[]> {
		const file = Bun.file(this.logFile);
		const count = Math.trunc(limit);
		// slice(-0), fractional limits below 1, negative and non-finite limits
		// have existing whole-file semantics; don't narrow that compatibility.
		if (!Number.isFinite(count) || count <= 0) {
			return (await file.text()).trim().split("\n").filter(Boolean);
		}
		const size = file.size;
		let windowBytes = 256 * 1024;
		while (true) {
			const start = Math.max(0, size - windowBytes);
			const bytes = await file.slice(start, size).arrayBuffer();
			if (bytes.byteLength !== size - start) {
				// Rotation/truncation raced the size snapshot. Read the current file
				// rather than treating an incomplete tail as complete history.
				return (await Bun.file(this.logFile).text())
					.trim()
					.split("\n")
					.filter(Boolean);
			}
			let text = new TextDecoder().decode(bytes);
			if (start > 0) {
				const newline = text.indexOf("\n");
				// Drop the partial first line, including any split UTF-8 character.
				text = newline < 0 ? "" : text.slice(newline + 1).trimEnd();
			} else {
				text = text.trim();
			}
			// Interior whitespace/malformed lines count toward the limit, just
			// as before; parsing happens only after slicing in readLogs().
			const lines = text.split("\n").filter(Boolean);
			if (start === 0 || lines.length >= count) return lines;
			windowBytes *= 2;
		}
	}

	close(): void {
		if (this.stream) {
			this.stream.end();
			this.stream = null;
		}
	}

	dispose(): void {
		this.close();
	}
}

// Check if we're in a Node.js/Bun environment (not browser)
const isNodeEnvironment =
	typeof process !== "undefined" &&
	process.versions != null &&
	process.versions.node != null;

// Singleton instance - only create in Node.js environments
export const logFileWriter: LogFileWriter | null = isNodeEnvironment
	? new LogFileWriter()
	: null;

// Register with lifecycle manager (only in Node.js)
if (logFileWriter) {
	registerDisposable(logFileWriter);
}
