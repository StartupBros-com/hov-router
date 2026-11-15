import { isStorageFullError } from "@better-ccflare/core";

/** Uncaught storage-full errors this process has survived (#827). */
export interface StorageFullBackstopStatus {
	count: number;
	lastError: string | null;
	lastErrorAt: number | null;
}

export interface StorageFullBackstop {
	status(): StorageFullBackstopStatus;
	uninstall(): void;
}

type Origin = "uncaughtException" | "unhandledRejection";

interface ErrorEvents {
	on(event: Origin, listener: (error: unknown) => void): unknown;
	off(event: Origin, listener: (error: unknown) => void): unknown;
}

export interface StorageFullBackstopOptions {
	/** Replaces the process in tests. */
	target?: ErrorEvents;
	exit?: (code: number) => void;
	report?: (line: string, error: unknown) => void;
	now?: () => number;
}

/** A disk that stays full repeats itself, so say it at most this often. */
export const STORAGE_FULL_REPORT_INTERVAL_MS = 30_000;

function describe(error: unknown): string {
	if (error instanceof Error) return error.message;
	try {
		return String(error);
	} catch {
		return "unknown error";
	}
}

/**
 * Keep the server running when a write fails for lack of disk space
 * somewhere nothing catches it (#827).
 *
 * The 2026-11-14 outage began with one: a log stream with no error listener
 * turned a full disk into an uncaught exception, and the runtime ended the
 * process. That stream is fixed, and so is every other write the full-disk
 * scenario reaches. This is for the ones it does not reach.
 *
 * Only an error that says the disk is full is survived. Anything else still
 * ends the process with code 1, as it does with no handler installed: that
 * includes I/O errors, which can mean a failing device.
 *
 * Every survived error is counted and shown on `/health`. A count above zero
 * means some write still has no handling of its own, and that is a defect to
 * fix where the write is made: carrying on after an exception nobody caught
 * leaves whatever that code was doing unfinished.
 *
 * The server installs this once its start has finished. A start that fails,
 * for lack of space or anything else, still ends the process with code 1:
 * surviving it would leave a process that never listened.
 *
 * Covers the main thread only. An error thrown inside a database worker
 * thread never reaches these handlers; each worker's owner listens for it.
 */
export function installStorageFullBackstop(
	options: StorageFullBackstopOptions = {},
): StorageFullBackstop {
	const target: ErrorEvents = options.target ?? process;
	const exit = options.exit ?? ((code: number) => process.exit(code));
	const report =
		options.report ??
		((line: string, error: unknown) => console.error(line, error));
	const now = options.now ?? Date.now;

	let count = 0;
	let lastError: string | null = null;
	let lastErrorAt: number | null = null;
	let reportedAt: number | null = null;
	let unreported = 0;

	const say = (line: string, error: unknown): void => {
		try {
			report(line, error);
		} catch {
			// stderr can be unwritable for the same reason the write was.
		}
	};

	const handler = (origin: Origin) => (error: unknown) => {
		if (!isStorageFullError(error)) {
			say(`[fatal] ${origin}; exiting with code 1:`, error);
			exit(1);
			return;
		}
		count += 1;
		lastError = describe(error);
		lastErrorAt = now();
		if (
			reportedAt !== null &&
			lastErrorAt - reportedAt < STORAGE_FULL_REPORT_INTERVAL_MS
		) {
			unreported += 1;
			return;
		}
		const more = unreported > 0 ? ` (and ${unreported} more since)` : "";
		reportedAt = lastErrorAt;
		unreported = 0;
		say(
			`[storage-full] ${origin}: a write failed because there is no space left on the device, and nothing handled it${more}. The server carries on without that write; ${count} so far:`,
			error,
		);
	};

	const onException = handler("uncaughtException");
	const onRejection = handler("unhandledRejection");
	target.on("uncaughtException", onException);
	target.on("unhandledRejection", onRejection);

	return {
		status: () => ({ count, lastError, lastErrorAt }),
		uninstall: () => {
			target.off("uncaughtException", onException);
			target.off("unhandledRejection", onRejection);
		},
	};
}
