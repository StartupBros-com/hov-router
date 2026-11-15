import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { isStorageFullError } from "./storage-full";

/** A real SQLITE_FULL, raised by SQLite itself against a page ceiling. */
function realSqliteFullError(): unknown {
	const db = new Database(":memory:");
	try {
		db.run("CREATE TABLE t (v TEXT)");
		// A ceiling below the current size is clamped to the current size.
		db.run("PRAGMA max_page_count = 1");
		for (let i = 0; i < 100; i++) {
			db.run("INSERT INTO t (v) VALUES (?)", ["x".repeat(4000)]);
		}
	} catch (error) {
		return error;
	} finally {
		db.close();
	}
	throw new Error("the page ceiling never produced an error");
}

function nodeError(code: string, errno: number): Error {
	return Object.assign(new Error(`${code}: write`), {
		code,
		errno,
		syscall: "write",
	});
}

describe("isStorageFullError", () => {
	it("recognises the error SQLite raises when it runs out of room", () => {
		const error = realSqliteFullError() as Error & { code?: string };
		expect(error.code).toBe("SQLITE_FULL");
		expect(isStorageFullError(error)).toBe(true);
	});

	it("recognises the same error after it crossed the writer thread", () => {
		// off-thread-reader.ts rebuilds a plain Error from message, name, code
		// and errno; nothing else survives the hop.
		const original = realSqliteFullError() as Error & {
			code?: string;
			errno?: number;
		};
		const rebuilt = Object.assign(new Error(original.message), {
			name: original.name,
			code: original.code,
			errno: original.errno,
		});
		expect(isStorageFullError(rebuilt)).toBe(true);
	});

	it("recognises a full filesystem and an exhausted quota from Node", () => {
		expect(isStorageFullError(nodeError("ENOSPC", -28))).toBe(true);
		expect(isStorageFullError(nodeError("EDQUOT", -122))).toBe(true);
	});

	it("recognises the SQLite message when the code was lost in a rethrow", () => {
		const original = realSqliteFullError() as Error;
		expect(isStorageFullError(new Error(String(original)))).toBe(true);
	});

	it("follows the cause chain", () => {
		const wrapped = new Error("could not save", {
			cause: new Error("inner", { cause: nodeError("ENOSPC", -28) }),
		});
		expect(isStorageFullError(wrapped)).toBe(true);
	});

	it("survives a cause chain that loops back on itself", () => {
		const a = new Error("a") as Error & { cause?: unknown };
		const b = new Error("b", { cause: a });
		a.cause = b;
		expect(isStorageFullError(a)).toBe(false);
	});

	it("does not claim errors that can mean a failing device or a busy database", () => {
		for (const code of [
			"EIO",
			"EACCES",
			"EROFS",
			"ENOENT",
			"SQLITE_BUSY",
			"SQLITE_CORRUPT",
			"SQLITE_READONLY",
			// Raised when the WAL index cannot grow on a full disk, and also by
			// real I/O failures: too ambiguous to tolerate.
			"SQLITE_IOERR_SHMSIZE",
			"SQLITE_IOERR_WRITE",
		]) {
			expect({ code, full: isStorageFullError(nodeError(code, 1)) }).toEqual({
				code,
				full: false,
			});
		}
		expect(isStorageFullError(new Error("disk I/O error"))).toBe(false);
		expect(isStorageFullError(undefined)).toBe(false);
		expect(isStorageFullError(null)).toBe(false);
		expect(isStorageFullError("ENOSPC")).toBe(false);
	});
});
