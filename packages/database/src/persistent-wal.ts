import { constants, type Database } from "bun:sqlite";

/**
 * Size SQLite cuts the log back to after a log reset. The 60 s checkpoint
 * already truncates the log to zero, so this bound only matters at close: with
 * any non-negative limit, a persistent log is truncated to zero bytes instead
 * of being left full of frames that are already in the database.
 */
export const WAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;

/**
 * Keeps `-wal` and `-shm` in place when this connection is the last to close.
 *
 * By default the last close deletes both, and the next open has to allocate
 * the 32 KiB `-shm` index again. On a full filesystem that allocation fails
 * with `SQLITE_IOERR_SHMSIZE`, so a router stopped cleanly while the disk was
 * full could not start again until someone freed space (#827). With the index
 * left allocated, a start needs no new blocks to open the database.
 *
 * The setting is per connection and the connection that closes last decides,
 * so every read-write connection calls this. A connection from outside (the
 * `sqlite3` shell, an older binary) that closes last still deletes the files;
 * the next start with free space puts them back.
 *
 * Best effort: a database that cannot take either setting still works, it
 * only loses the full-disk restart.
 */
export function keepWalFilesOnClose(db: Database): void {
	try {
		// The limit goes first, and persistence is never set without it: a
		// persistent log with no limit is left at full size, stale frames
		// included, next to a database someone may later replace.
		db.run(`PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT_BYTES}`);
		db.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 1);
	} catch (error) {
		console.warn(
			"Could not keep the SQLite WAL files across a close; a restart on a full disk will need free space:",
			error,
		);
	}
}
