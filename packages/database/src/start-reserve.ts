import { randomBytes } from "node:crypto";
import { constants, realpathSync, rmSync, statfsSync, statSync } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { dirname } from "node:path";
import { isStorageFullError } from "@hov-router/core";

/**
 * Size of the start reserve: a file of written bytes kept beside the database
 * so that a start on a full disk has blocks to give back.
 *
 * The first connection to open the database truncates the WAL index and
 * writes it again. On full 128 MB ext4 images that rebuild failed in almost
 * every measured start: it can need a block more than the truncate released
 * (#827). Sixteen 4 KiB blocks cover the eight the rebuild writes twice over.
 */
export const START_RESERVE_BYTES = 64 * 1024;

/**
 * How much the filesystem must have available before an index I/O error at
 * the open is taken for something other than a full disk.
 *
 * Sixteen times the reserve, so the blocks a start has just released can
 * never read as room.
 */
export const START_ROOM_BYTES = 1024 * 1024;

const CHUNK_BYTES = 4096;
const MAX_CAUSE_DEPTH = 8;

export interface StartReserveArmResult {
	/** True when the reserve holds its full size. */
	armed: boolean;
	/** Bytes the reserve holds now. */
	bytes: number;
	/** Why the reserve is short, when it is. */
	error?: unknown;
}

export interface StartReserveRelease {
	/** True when a reserve with bytes in it was removed. */
	released: boolean;
	bytes: number;
}

export function startReservePath(dbPath: string): string {
	return `${dbPath}.start-reserve`;
}

function hasReserve(dbPath: string): boolean {
	return dbPath !== "" && dbPath !== ":memory:";
}

/**
 * Bring the reserve up to its full size, writing from its current end.
 *
 * Never throws: on a disk that is still full this fails every time, and the
 * caller only needs to know whether the next start is covered. Whatever part
 * was written stays; a short reserve still gives back what it holds.
 *
 * Writes go to fixed offsets and never past the full size, so two processes
 * arming the same reserve (a retiring backend and its replacement) leave one
 * reserve of the right size.
 */
export async function armStartReserve(
	dbPath: string,
	targetBytes: number = START_RESERVE_BYTES,
): Promise<StartReserveArmResult> {
	if (!hasReserve(dbPath)) return { armed: false, bytes: 0 };
	let handle: FileHandle | undefined;
	let bytes = 0;
	try {
		handle = await open(
			startReservePath(dbPath),
			constants.O_RDWR | constants.O_CREAT,
			0o600,
		);
		const { size } = await handle.stat();
		if (size >= targetBytes) return { armed: true, bytes: size };

		// Start on a chunk boundary so a reserve cut short mid-chunk is
		// rewritten from the last whole chunk and never left with a hole.
		const start = Math.floor(size / CHUNK_BYTES) * CHUNK_BYTES;
		bytes = start;
		// Random bytes: a filesystem that compresses or elides zeros would
		// otherwise keep a reserve that holds no blocks.
		const fill = randomBytes(targetBytes - start);
		let written = 0;
		while (written < fill.length) {
			const { bytesWritten } = await handle.write(
				fill,
				written,
				fill.length - written,
				start + written,
			);
			if (bytesWritten <= 0) {
				throw new Error("the start reserve write made no progress");
			}
			written += bytesWritten;
			bytes = start + written;
		}
		try {
			await handle.sync();
		} catch (error) {
			// Bytes that could not be made durable may hold no blocks. Drop
			// them so the next attempt writes them again instead of seeing a
			// file of the full size.
			await handle.truncate(start).catch(() => {});
			bytes = start;
			throw error;
		}
		return { armed: true, bytes };
	} catch (error) {
		return { armed: false, bytes, error };
	} finally {
		await handle?.close().catch(() => {});
	}
}

/**
 * Remove the reserve so its blocks are free for the database open that
 * follows. Synchronous, and nothing else is done here, on purpose: whatever
 * runs between the release and the open gives another writer time to take
 * the blocks first.
 *
 * Only the server's start calls this. A CLI command that opens the database
 * on a full disk fails as before rather than spend the reserve the next
 * server start depends on.
 */
export function releaseStartReserve(dbPath: string): StartReserveRelease {
	const nothing: StartReserveRelease = { released: false, bytes: 0 };
	if (!hasReserve(dbPath)) return nothing;
	const path = startReservePath(dbPath);
	let bytes: number;
	try {
		bytes = statSync(path).size;
		rmSync(path, { force: true });
	} catch {
		return nothing;
	}
	if (bytes === 0) return nothing;
	return { released: true, bytes };
}

/**
 * True when a database open failed for lack of space.
 *
 * `SQLITE_IOERR_SHMSIZE` is how a first connection reports that it could not
 * rebuild the WAL index. `isStorageFullError` leaves it out because a failing
 * device raises it too; here a false positive costs one 64 KiB file and one
 * more open, so it is included.
 */
export function isOpenOutOfSpaceError(error: unknown): boolean {
	if (isStorageFullError(error)) return true;
	let current: unknown = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
		if (typeof current !== "object" || current === null) return false;
		if ((current as { code?: unknown }).code === "SQLITE_IOERR_SHMSIZE") {
			return true;
		}
		current = (current as { cause?: unknown }).cause;
	}
	return false;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * A start that could not open the database because the disk has no space
 * left, and had no reserve, or not enough of one, to get past it (#827).
 *
 * The start stops here. A server that came up without the database, or on a
 * schema it could not finish updating, would be worse than one that says
 * why it did not. `cause` holds what SQLite reported.
 */
export class StartOutOfSpaceError extends Error {
	readonly reserveReleased: boolean;
	/**
	 * What the database's filesystem had available when the start gave up, or
	 * null when that could not be measured.
	 */
	readonly availableBytes: number | null;

	constructor(
		start: {
			dbPath: string;
			releasedBytes: number;
			availableBytes?: number | null;
		},
		options: { cause: unknown },
	) {
		const { dbPath, releasedBytes } = start;
		const availableBytes = start.availableBytes ?? null;
		super(
			`Cannot start: the database at ${dbPath} could not be opened because the disk has no space left (${describeError(options.cause)}; ${
				availableBytes === null
					? "the space available could not be measured"
					: `${availableBytes} bytes available`
			}). ${
				releasedBytes > 0
					? `Releasing the ${releasedBytes}-byte start reserve was not enough.`
					: "There was no start reserve to release."
			} Free space on that filesystem and start again.`,
			options,
		);
		this.name = "StartOutOfSpaceError";
		this.reserveReleased = releasedBytes > 0;
		this.availableBytes = availableBytes;
	}
}

/** Bytes an unprivileged writer can still take on the filesystem of `directory`. */
function availableBytesIn(directory: string): number {
	const { bavail, bsize } = statfsSync(directory);
	return Number(bavail) * Number(bsize);
}

/**
 * The directory SQLite keeps the database's index in.
 *
 * SQLite names the index after the database's real path, so for a database
 * path that is a link this is the target's directory, which can be on another
 * filesystem. A path that cannot be resolved (no file yet, or a link that
 * leads nowhere) is taken as it is configured.
 */
function indexDirectory(dbPath: string): string {
	try {
		return dirname(realpathSync(dbPath));
	} catch {
		return dirname(dbPath);
	}
}

/**
 * Give up on a start whose open failed for lack of space, or pass the
 * failure on when it was not that after all.
 *
 * SQLite's own "full" is believed as it is. An index I/O error is not: a
 * failing device raises it on a disk with plenty of room, and the runner
 * waits out a start refused for space for as long as it takes (#827). So that
 * one is a refusal only when the filesystem is short of room as well. A
 * measurement that fails counts as short: the outage was a runner that gave
 * up, not one that waited.
 */
function refuseForSpace(
	dbPath: string,
	releasedBytes: number,
	error: unknown,
	measureAvailableBytes: (directory: string) => number,
): never {
	let availableBytes: number | null;
	try {
		availableBytes = measureAvailableBytes(indexDirectory(dbPath));
	} catch {
		availableBytes = null;
	}
	if (
		!isStorageFullError(error) &&
		availableBytes !== null &&
		availableBytes >= START_ROOM_BYTES
	) {
		throw error;
	}
	throw new StartOutOfSpaceError(
		{ dbPath, releasedBytes, availableBytes },
		{ cause: error },
	);
}

/**
 * Open the database, and when the open fails for lack of space, release the
 * start reserve and open once more.
 *
 * The reserve is spent only when an open fails for lack of space, so a start
 * that opens without it leaves it for a later start.
 *
 * One start per reserve: once spent it can only be put back when space
 * returns (`armStartReserve`), so a second start on a disk that stayed full
 * is on its own.
 *
 * An open that still fails for lack of space throws `StartOutOfSpaceError`.
 * Any other failure is passed on as it is, and so is an index I/O error on a
 * filesystem that has room (`START_ROOM_BYTES`).
 */
export function openWithStartReserve<T>(
	dbPath: string,
	openDatabase: () => T,
	onRelease?: (bytes: number, error: unknown) => void,
	measureAvailableBytes: (directory: string) => number = availableBytesIn,
): T {
	try {
		return openDatabase();
	} catch (error) {
		if (!isOpenOutOfSpaceError(error)) throw error;
		// An in-memory database has no file, no reserve and no disk to free.
		if (dbPath === ":memory:") throw error;
		const { released, bytes } = releaseStartReserve(dbPath);
		if (!released) refuseForSpace(dbPath, 0, error, measureAvailableBytes);
		onRelease?.(bytes, error);
		try {
			return openDatabase();
		} catch (secondError) {
			if (!isOpenOutOfSpaceError(secondError)) throw secondError;
			refuseForSpace(dbPath, bytes, secondError, measureAvailableBytes);
		}
	}
}
