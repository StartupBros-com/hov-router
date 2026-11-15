import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	armStartReserve,
	isOpenOutOfSpaceError,
	openWithStartReserve,
	releaseStartReserve,
	START_RESERVE_BYTES,
	START_ROOM_BYTES,
	StartOutOfSpaceError,
	startReservePath,
} from "../start-reserve";

function thrownBy(run: () => unknown): unknown {
	try {
		run();
	} catch (error) {
		return error;
	}
	throw new Error("nothing was thrown");
}

function codedError(code: string, message = "disk I/O error"): Error {
	return Object.assign(new Error(message), { code });
}

/** A filesystem with nothing available, as a full one reports itself. */
const noRoom = () => 0;
/** A filesystem with plenty available: whatever failed, it was not space. */
const PLENTY_BYTES = 64 * 1024 * 1024 * 1024;
const plentyOfRoom = () => PLENTY_BYTES;

describe("start reserve", () => {
	let dir: string;
	let dbPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "better-ccflare-start-reserve-"));
		dbPath = join(dir, "router.db");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	describe("armStartReserve", () => {
		it("writes a private file of the full size with real blocks", async () => {
			const result = await armStartReserve(dbPath);

			expect(result).toEqual({ armed: true, bytes: START_RESERVE_BYTES });
			const stat = statSync(startReservePath(dbPath));
			expect(stat.size).toBe(START_RESERVE_BYTES);
			expect(stat.mode & 0o777).toBe(0o600);
			// Written bytes, not a hole: a sparse file would hold no blocks to
			// give back.
			expect(stat.blocks * 512).toBeGreaterThanOrEqual(START_RESERVE_BYTES);
		});

		it("leaves a full reserve alone", async () => {
			await armStartReserve(dbPath);
			const before = statSync(startReservePath(dbPath));

			const result = await armStartReserve(dbPath);

			expect(result).toEqual({ armed: true, bytes: START_RESERVE_BYTES });
			const after = statSync(startReservePath(dbPath));
			expect(after.mtimeMs).toBe(before.mtimeMs);
			expect(after.ino).toBe(before.ino);
		});

		it("tops up a short reserve to the full size", async () => {
			writeFileSync(startReservePath(dbPath), Buffer.alloc(10_000, 1));

			const result = await armStartReserve(dbPath);

			expect(result).toEqual({ armed: true, bytes: START_RESERVE_BYTES });
			const stat = statSync(startReservePath(dbPath));
			expect(stat.size).toBe(START_RESERVE_BYTES);
			expect(stat.blocks * 512).toBeGreaterThanOrEqual(START_RESERVE_BYTES);
		});

		it.skipIf(!existsSync("/dev/full"))(
			"reports a full disk instead of throwing",
			async () => {
				// /dev/full fails every write with ENOSPC, which is what the
				// reserve meets when it is put back before space has returned.
				symlinkSync("/dev/full", startReservePath(dbPath));

				const result = await armStartReserve(dbPath);

				expect(result.armed).toBe(false);
				expect(result.bytes).toBe(0);
				expect((result.error as NodeJS.ErrnoException).code).toBe("ENOSPC");
			},
		);

		it("reports any other failure instead of throwing", async () => {
			const result = await armStartReserve(join(dir, "missing", "router.db"));

			expect(result.armed).toBe(false);
			expect(result.bytes).toBe(0);
			expect((result.error as NodeJS.ErrnoException).code).toBe("ENOENT");
		});
	});

	describe("releaseStartReserve", () => {
		it("removes the reserve and reports what it held", async () => {
			await armStartReserve(dbPath);

			expect(releaseStartReserve(dbPath)).toEqual({
				released: true,
				bytes: START_RESERVE_BYTES,
			});
			expect(existsSync(startReservePath(dbPath))).toBe(false);
		});

		it("reports nothing released when there is no reserve", () => {
			expect(releaseStartReserve(dbPath)).toEqual({
				released: false,
				bytes: 0,
			});
		});

		it("reports nothing released for an empty reserve, and removes it", () => {
			writeFileSync(startReservePath(dbPath), "");

			expect(releaseStartReserve(dbPath)).toEqual({
				released: false,
				bytes: 0,
			});
			expect(existsSync(startReservePath(dbPath))).toBe(false);
		});
	});

	describe("isOpenOutOfSpaceError", () => {
		it("recognises the WAL index rebuild failure and plain full-disk errors", () => {
			expect(isOpenOutOfSpaceError(codedError("SQLITE_IOERR_SHMSIZE"))).toBe(
				true,
			);
			expect(isOpenOutOfSpaceError(codedError("SQLITE_FULL"))).toBe(true);
			expect(isOpenOutOfSpaceError(codedError("ENOSPC"))).toBe(true);
			expect(
				isOpenOutOfSpaceError(
					new Error("wrapped", { cause: codedError("SQLITE_IOERR_SHMSIZE") }),
				),
			).toBe(true);
		});

		it("does not recognise other I/O or schema failures", () => {
			expect(isOpenOutOfSpaceError(codedError("SQLITE_IOERR_READ"))).toBe(
				false,
			);
			expect(isOpenOutOfSpaceError(codedError("SQLITE_CORRUPT"))).toBe(false);
			expect(isOpenOutOfSpaceError(codedError("EIO"))).toBe(false);
			expect(isOpenOutOfSpaceError(new Error("no such table"))).toBe(false);
			expect(isOpenOutOfSpaceError(undefined)).toBe(false);
		});
	});

	describe("openWithStartReserve", () => {
		it("keeps the reserve when the open succeeds", async () => {
			await armStartReserve(dbPath);
			let calls = 0;

			const value = openWithStartReserve(dbPath, () => {
				calls++;
				return "opened";
			});

			expect(value).toBe("opened");
			expect(calls).toBe(1);
			expect(statSync(startReservePath(dbPath)).size).toBe(START_RESERVE_BYTES);
		});

		it("releases the reserve and opens again when the open runs out of space", async () => {
			await armStartReserve(dbPath);
			const reservePresent: boolean[] = [];
			const released: number[] = [];

			const value = openWithStartReserve(
				dbPath,
				() => {
					reservePresent.push(existsSync(startReservePath(dbPath)));
					if (reservePresent.length === 1) {
						throw codedError("SQLITE_IOERR_SHMSIZE");
					}
					return "opened";
				},
				(bytes) => released.push(bytes),
			);

			expect(value).toBe("opened");
			// The second open ran after the reserve was gone.
			expect(reservePresent).toEqual([true, false]);
			expect(released).toEqual([START_RESERVE_BYTES]);
		});

		it("rethrows a failure that is not about space and keeps the reserve", async () => {
			await armStartReserve(dbPath);
			let calls = 0;
			const failure = codedError(
				"SQLITE_CORRUPT",
				"database disk image is malformed",
			);

			expect(() =>
				openWithStartReserve(dbPath, () => {
					calls++;
					throw failure;
				}),
			).toThrow(failure);
			expect(calls).toBe(1);
			expect(statSync(startReservePath(dbPath)).size).toBe(START_RESERVE_BYTES);
		});

		it("refuses by name, without a second open, when there is no reserve to release", () => {
			let calls = 0;
			const failure = codedError("SQLITE_IOERR_SHMSIZE");

			const refusal = thrownBy(() =>
				openWithStartReserve(
					dbPath,
					() => {
						calls++;
						throw failure;
					},
					undefined,
					noRoom,
				),
			) as StartOutOfSpaceError;

			expect(refusal).toBeInstanceOf(StartOutOfSpaceError);
			expect(refusal.cause).toBe(failure);
			expect(refusal.reserveReleased).toBe(false);
			expect(refusal.availableBytes).toBe(0);
			expect(refusal.message).toContain(dbPath);
			expect(refusal.message).toContain("disk I/O error");
			expect(refusal.message).toContain("0 bytes available");
			expect(refusal.message).toContain("no start reserve");
			expect(refusal.message).toContain("Free space");
			expect(calls).toBe(1);
		});

		it("refuses by name, with the second failure, when the reserve was not enough", async () => {
			await armStartReserve(dbPath);
			let calls = 0;
			const second = codedError("SQLITE_FULL", "database or disk is full");

			const refusal = thrownBy(() =>
				openWithStartReserve(dbPath, () => {
					calls++;
					throw calls === 1 ? codedError("SQLITE_IOERR_SHMSIZE") : second;
				}),
			) as StartOutOfSpaceError;

			expect(refusal).toBeInstanceOf(StartOutOfSpaceError);
			expect(refusal.cause).toBe(second);
			expect(refusal.reserveReleased).toBe(true);
			expect(refusal.message).toContain(dbPath);
			expect(refusal.message).toContain("database or disk is full");
			expect(refusal.message).toContain(
				`${START_RESERVE_BYTES}-byte start reserve`,
			);
			// Still a full-disk error to anything that asks.
			expect(isOpenOutOfSpaceError(refusal)).toBe(true);
			expect(calls).toBe(2);
			expect(existsSync(startReservePath(dbPath))).toBe(false);
		});

		it("passes on a second failure that is not about space as it is", async () => {
			await armStartReserve(dbPath);
			let calls = 0;
			const second = codedError(
				"SQLITE_CORRUPT",
				"database disk image is malformed",
			);

			expect(() =>
				openWithStartReserve(dbPath, () => {
					calls++;
					throw calls === 1 ? codedError("SQLITE_IOERR_SHMSIZE") : second;
				}),
			).toThrow(second);
			expect(calls).toBe(2);
		});

		describe("an index I/O error, which a failing device raises too", () => {
			it("is passed on as it is when the filesystem has room", () => {
				let calls = 0;
				const measured: string[] = [];
				const failure = codedError("SQLITE_IOERR_SHMSIZE");

				const thrown = thrownBy(() =>
					openWithStartReserve(
						dbPath,
						() => {
							calls++;
							throw failure;
						},
						undefined,
						(directory) => {
							measured.push(directory);
							return PLENTY_BYTES;
						},
					),
				);

				// Not a refusal for space: the start exits 1 and the runner
				// counts it, instead of waiting for space that is already there.
				expect(thrown).toBe(failure);
				expect(thrown).not.toBeInstanceOf(StartOutOfSpaceError);
				expect(calls).toBe(1);
				// Measured where the index file lives.
				expect(measured).toEqual([dir]);
			});

			it("is passed on after the reserve was released, when there is room all the same", async () => {
				await armStartReserve(dbPath);
				let calls = 0;
				const first = codedError("SQLITE_IOERR_SHMSIZE");
				const second = codedError("SQLITE_IOERR_SHMSIZE");

				const thrown = thrownBy(() =>
					openWithStartReserve(
						dbPath,
						() => {
							calls++;
							throw calls === 1 ? first : second;
						},
						undefined,
						plentyOfRoom,
					),
				);

				expect(thrown).toBe(second);
				expect(calls).toBe(2);
			});

			it("is a refusal for space when the filesystem has no room", async () => {
				await armStartReserve(dbPath);
				let calls = 0;
				const second = codedError("SQLITE_IOERR_SHMSIZE");

				const refusal = thrownBy(() =>
					openWithStartReserve(
						dbPath,
						() => {
							calls++;
							throw calls === 1 ? codedError("SQLITE_IOERR_SHMSIZE") : second;
						},
						undefined,
						noRoom,
					),
				) as StartOutOfSpaceError;

				expect(refusal).toBeInstanceOf(StartOutOfSpaceError);
				expect(refusal.cause).toBe(second);
				expect(refusal.reserveReleased).toBe(true);
				expect(refusal.availableBytes).toBe(0);
				expect(refusal.message).toContain("0 bytes available");
				expect(calls).toBe(2);
			});

			it("counts as room only at the threshold, far above what the reserve gives back", () => {
				// The reserve this start may have just released must never read
				// as room.
				expect(START_ROOM_BYTES).toBeGreaterThanOrEqual(
					START_RESERVE_BYTES * 8,
				);
				const failure = codedError("SQLITE_IOERR_SHMSIZE");
				const open = () => {
					throw failure;
				};

				const below = thrownBy(() =>
					openWithStartReserve(
						dbPath,
						open,
						undefined,
						() => START_ROOM_BYTES - 1,
					),
				) as StartOutOfSpaceError;
				const at = thrownBy(() =>
					openWithStartReserve(dbPath, open, undefined, () => START_ROOM_BYTES),
				);

				expect(below).toBeInstanceOf(StartOutOfSpaceError);
				expect(below.availableBytes).toBe(START_ROOM_BYTES - 1);
				expect(at).toBe(failure);
			});

			it("is a refusal for space when the free space cannot be measured", () => {
				// The outage was a runner that gave up, not one that waited. A
				// start that cannot tell is treated as out of space.
				const failure = codedError("SQLITE_IOERR_SHMSIZE");

				const refusal = thrownBy(() =>
					openWithStartReserve(
						dbPath,
						() => {
							throw failure;
						},
						undefined,
						() => {
							throw codedError("EACCES", "permission denied");
						},
					),
				) as StartOutOfSpaceError;

				expect(refusal).toBeInstanceOf(StartOutOfSpaceError);
				expect(refusal.cause).toBe(failure);
				expect(refusal.availableBytes).toBeNull();
				expect(refusal.message).toContain("could not be measured");
			});

			it("measures where a linked database really is", () => {
				// SQLite names its index after a link's target, so the target's
				// filesystem is the one that ran out. Here the link's own
				// directory has room and the target's has none.
				const data = join(dir, "data");
				mkdirSync(data);
				writeFileSync(join(data, "router.db"), "");
				const linked = join(dir, "linked.db");
				symlinkSync(join(data, "router.db"), linked);
				const whereItIs = realpathSync(data);
				const measured: string[] = [];
				const failure = codedError("SQLITE_IOERR_SHMSIZE");

				const refusal = thrownBy(() =>
					openWithStartReserve(
						linked,
						() => {
							throw failure;
						},
						undefined,
						(directory) => {
							measured.push(directory);
							return directory === whereItIs ? 0 : PLENTY_BYTES;
						},
					),
				) as StartOutOfSpaceError;

				expect(measured).toEqual([whereItIs]);
				expect(refusal).toBeInstanceOf(StartOutOfSpaceError);
				expect(refusal.cause).toBe(failure);
				expect(refusal.availableBytes).toBe(0);
			});

			it("measures the configured directory when a link leads nowhere", () => {
				const linked = join(dir, "linked.db");
				symlinkSync(join(dir, "gone", "router.db"), linked);
				const measured: string[] = [];
				const failure = codedError("SQLITE_IOERR_SHMSIZE");

				const refusal = thrownBy(() =>
					openWithStartReserve(
						linked,
						() => {
							throw failure;
						},
						undefined,
						(directory) => {
							measured.push(directory);
							return 0;
						},
					),
				) as StartOutOfSpaceError;

				expect(measured).toEqual([dir]);
				expect(refusal).toBeInstanceOf(StartOutOfSpaceError);
			});
		});

		it("refuses for a database that says it is full, whatever the filesystem reports", () => {
			// A quota, or another writer that took the blocks back, leaves room
			// on the filesystem and none for this write. SQLite's own "full" is
			// believed without a second opinion.
			let calls = 0;
			const failure = codedError("SQLITE_FULL", "database or disk is full");

			const refusal = thrownBy(() =>
				openWithStartReserve(
					dbPath,
					() => {
						calls++;
						throw failure;
					},
					undefined,
					plentyOfRoom,
				),
			) as StartOutOfSpaceError;

			expect(refusal).toBeInstanceOf(StartOutOfSpaceError);
			expect(refusal.cause).toBe(failure);
			expect(refusal.availableBytes).toBe(PLENTY_BYTES);
			expect(refusal.message).toContain("68719476736 bytes available");
			expect(calls).toBe(1);
		});

		it("measures the real filesystem when it is given no measurement", () => {
			// The temp directory this test runs in has room, so an index error
			// here is not a full disk. A measurement that silently failed would
			// make it one.
			const failure = codedError("SQLITE_IOERR_SHMSIZE");

			const thrown = thrownBy(() =>
				openWithStartReserve(dbPath, () => {
					throw failure;
				}),
			);

			expect(thrown).toBe(failure);
		});

		it("never touches a reserve for an in-memory database", () => {
			let calls = 0;

			expect(() =>
				openWithStartReserve(":memory:", () => {
					calls++;
					throw codedError("SQLITE_FULL", "database or disk is full");
				}),
			).toThrow("database or disk is full");
			expect(calls).toBe(1);
		});
	});
});
