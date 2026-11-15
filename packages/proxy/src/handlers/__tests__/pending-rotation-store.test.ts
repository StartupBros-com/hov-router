import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { createHash } from "node:crypto";
import {
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PendingRotationPersistence } from "../pending-rotation-registry";
import {
	createPendingRotationSlotStore,
	type PendingRotationSlotStore,
	SLOT_FILE_BYTES,
} from "../pending-rotation-slots";
import {
	composePendingRotationStores,
	createPendingRotationStore,
} from "../pending-rotation-store";
import { createPendingRotationWal } from "../pending-rotation-wal";

const SECRET = "pending-rotation-store-test-secret-with-enough-entropy";

function rotation(label: string) {
	return {
		accessToken: `access-${label}`,
		expiresAt: 2_000_000_000_000,
		refreshToken: `refresh-${label}`,
		attemptedRefreshToken: `consumed-${label}`,
		createdAt: 101,
		recordedAt: 1_700_000_000_000,
	};
}

function storageFull(): Error {
	return Object.assign(new Error("ENOSPC: no space left on device, write"), {
		code: "ENOSPC",
	});
}

function makeLog() {
	return {
		info: mock(() => {}),
		warn: mock(() => {}),
		error: mock(() => {}),
	};
}

let directory: string;

const filesEndingWith = (suffix: string) =>
	readdirSync(directory).filter((name) => name.endsWith(suffix));

const digest = (accountId: string) =>
	createHash("sha256").update(accountId).digest("hex");

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "better-ccflare-pending-store-"));
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

describe("pending rotation store on disk", () => {
	it("saves to the slot and removes the account's legacy file", async () => {
		const legacy = createPendingRotationWal({ directory, secret: SECRET });
		await legacy.save("account-1", rotation("old"));
		expect(filesEndingWith(".wal")).toHaveLength(1);

		const store = createPendingRotationStore({ directory, secret: SECRET });
		await store.save("account-1", rotation("new"));

		expect(filesEndingWith(".wal")).toHaveLength(0);
		expect(filesEndingWith(".slot")).toHaveLength(1);
		expect(
			await createPendingRotationStore({ directory, secret: SECRET }).load(),
		).toEqual([{ accountId: "account-1", rotation: rotation("new") }]);
	});

	it("loads a legacy entry that has no slot and leaves its file in place", async () => {
		const legacy = createPendingRotationWal({ directory, secret: SECRET });
		await legacy.save("account-1", rotation("old"));

		const store = createPendingRotationStore({ directory, secret: SECRET });

		expect(await store.load()).toEqual([
			{ accountId: "account-1", rotation: rotation("old") },
		]);
		expect(filesEndingWith(".wal")).toHaveLength(1);
	});

	it("lets a pending slot shadow the legacy file for the same account, removes that file and says so", async () => {
		const log = makeLog();
		const store = createPendingRotationStore({
			directory,
			secret: SECRET,
			log,
		});
		await store.save("account-1", rotation("new"));
		// A legacy file left behind, as after an unlink that failed.
		await createPendingRotationWal({ directory, secret: SECRET }).save(
			"account-1",
			rotation("old"),
		);
		await createPendingRotationWal({ directory, secret: SECRET }).save(
			"account-2",
			rotation("other"),
		);

		const loaded = await store.load();

		expect(loaded).toHaveLength(2);
		expect(loaded).toContainEqual({
			accountId: "account-1",
			rotation: rotation("new"),
		});
		expect(loaded).toContainEqual({
			accountId: "account-2",
			rotation: rotation("other"),
		});
		expect(filesEndingWith(".wal")).toEqual([
			`pending-rotation-${digest("account-2")}.wal`,
		]);
		expect(log.info).toHaveBeenCalledTimes(1);
	});

	it("does not let a cleared slot hide a legacy entry", async () => {
		const store = createPendingRotationStore({ directory, secret: SECRET });
		await store.reserve("account-1");
		await createPendingRotationWal({ directory, secret: SECRET }).save(
			"account-1",
			rotation("old"),
		);

		expect(await store.load()).toEqual([
			{ accountId: "account-1", rotation: rotation("old") },
		]);
	});

	it("remove keeps the slot file allocated and removes the legacy file", async () => {
		const store = createPendingRotationStore({ directory, secret: SECRET });
		await store.save("account-1", rotation("new"));
		await createPendingRotationWal({ directory, secret: SECRET }).save(
			"account-1",
			rotation("old"),
		);
		const slot = join(directory, filesEndingWith(".slot")[0] as string);
		const inode = statSync(slot).ino;

		await store.remove("account-1");

		expect(await store.load()).toEqual([]);
		expect(filesEndingWith(".wal")).toHaveLength(0);
		expect(statSync(slot).size).toBe(SLOT_FILE_BYTES);
		expect(statSync(slot).ino).toBe(inode);
	});

	it("discard removes the slot and the legacy file", async () => {
		const store = createPendingRotationStore({ directory, secret: SECRET });
		await store.save("account-1", rotation("new"));
		await createPendingRotationWal({ directory, secret: SECRET }).save(
			"account-1",
			rotation("old"),
		);

		await store.discard("account-1");

		expect(readdirSync(directory)).toEqual([]);
	});

	it("reports an unreadable slot and still loads the rest", async () => {
		const log = makeLog();
		const store = createPendingRotationStore({
			directory,
			secret: SECRET,
			log,
		});
		await store.save("account-1", rotation("good"));
		await createPendingRotationStore({
			directory,
			secret: `${SECRET}-other`,
		}).save("account-2", rotation("foreign"));

		expect(await store.load()).toEqual([
			{ accountId: "account-1", rotation: rotation("good") },
		]);
		expect(log.error).toHaveBeenCalledTimes(1);
	});

	it("still fails the load on an unreadable legacy file", async () => {
		writeFileSync(
			join(directory, `pending-rotation-${digest("account-1")}.wal`),
			"not an envelope",
		);
		const store = createPendingRotationStore({ directory, secret: SECRET });

		await expect(store.load()).rejects.toBeDefined();
	});
});

describe("pending rotation store failure handling", () => {
	function realSlots(): PendingRotationSlotStore {
		return createPendingRotationSlotStore({ directory, secret: SECRET });
	}

	function fakeLegacy(
		overrides: Partial<PendingRotationPersistence> = {},
	): PendingRotationPersistence {
		return {
			save: mock(async () => {}),
			load: mock(async () => []),
			remove: mock(async () => {}),
			...overrides,
		};
	}

	function fakeSlots(
		overrides: Partial<PendingRotationSlotStore> = {},
	): PendingRotationSlotStore {
		return {
			reserve: mock(async () => {}),
			save: mock(async () => {}),
			clear: mock(async () => {}),
			discard: mock(async () => {}),
			load: mock(async () => []),
			...overrides,
		};
	}

	it("logs and keeps the save when the legacy file cannot be removed", async () => {
		const log = makeLog();
		const store = composePendingRotationStores({
			slots: realSlots(),
			legacy: fakeLegacy({
				remove: mock(async () => {
					throw new Error("EACCES: permission denied, unlink");
				}),
			}),
			log,
		});

		await expect(
			store.save("account-1", rotation("new")),
		).resolves.toBeUndefined();

		expect(log.warn).toHaveBeenCalledTimes(1);
		expect(await realSlots().load()).toEqual([
			{ accountId: "account-1", rotation: rotation("new") },
		]);
	});

	it("does not touch the legacy file when the slot save fails", async () => {
		const legacy = fakeLegacy();
		const store = composePendingRotationStores({
			slots: fakeSlots({
				save: mock(async () => {
					throw storageFull();
				}),
			}),
			legacy,
			log: makeLog(),
		});

		await expect(
			store.save("account-1", rotation("new")),
		).rejects.toMatchObject({ code: "ENOSPC" });
		expect(legacy.remove).not.toHaveBeenCalled();
	});

	it("logs and keeps the load when a shadowed legacy file cannot be removed", async () => {
		const log = makeLog();
		const slots = realSlots();
		await slots.save("account-1", rotation("new"));
		const store = composePendingRotationStores({
			slots,
			legacy: fakeLegacy({
				load: mock(async () => [
					{ accountId: "account-1", rotation: rotation("old") },
				]),
				remove: mock(async () => {
					throw new Error("EACCES: permission denied, unlink");
				}),
			}),
			log,
		});

		expect(await store.load()).toEqual([
			{ accountId: "account-1", rotation: rotation("new") },
		]);
		expect(log.warn).toHaveBeenCalledTimes(1);
	});

	it("still fails a remove whose legacy file cannot be removed", async () => {
		const store = composePendingRotationStores({
			slots: realSlots(),
			legacy: fakeLegacy({
				remove: mock(async () => {
					throw new Error("EACCES: permission denied, unlink");
				}),
			}),
			log: makeLog(),
		});

		await expect(store.remove("account-1")).rejects.toThrow("EACCES");
	});

	describe("reservation that fails for lack of space", () => {
		it("is not retried for the same account until the retry delay has passed", async () => {
			let now = 1_000;
			const reserve = mock(async () => {
				throw storageFull();
			});
			const store = composePendingRotationStores({
				slots: fakeSlots({ reserve }),
				legacy: fakeLegacy(),
				log: makeLog(),
				now: () => now,
				reserveRetryMs: 5_000,
			});

			await expect(store.reserve("account-1")).rejects.toMatchObject({
				code: "ENOSPC",
			});
			now += 4_999;
			await expect(store.reserve("account-1")).rejects.toMatchObject({
				code: "ENOSPC",
			});
			expect(reserve).toHaveBeenCalledTimes(1);

			now += 1;
			await expect(store.reserve("account-1")).rejects.toMatchObject({
				code: "ENOSPC",
			});
			expect(reserve).toHaveBeenCalledTimes(2);
		});

		it("succeeds again as soon as a retry finds space", async () => {
			let now = 1_000;
			let full = true;
			const reserve = mock(async () => {
				if (full) throw storageFull();
			});
			const store = composePendingRotationStores({
				slots: fakeSlots({ reserve }),
				legacy: fakeLegacy(),
				log: makeLog(),
				now: () => now,
				reserveRetryMs: 5_000,
			});

			await expect(store.reserve("account-1")).rejects.toBeDefined();
			full = false;
			now += 5_000;

			await expect(store.reserve("account-1")).resolves.toBeUndefined();
			await expect(store.reserve("account-1")).resolves.toBeUndefined();
			expect(reserve).toHaveBeenCalledTimes(3);
		});

		it("does not hold back another account", async () => {
			const reserve = mock(async (accountId: string) => {
				if (accountId === "no-slot") throw storageFull();
			});
			const store = composePendingRotationStores({
				slots: fakeSlots({ reserve }),
				legacy: fakeLegacy(),
				log: makeLog(),
				now: () => 1_000,
				reserveRetryMs: 5_000,
			});

			await expect(store.reserve("no-slot")).rejects.toBeDefined();
			await expect(store.reserve("has-slot")).resolves.toBeUndefined();
			expect(reserve).toHaveBeenCalledTimes(2);
		});

		it("retries at once after a failure that is not lack of space", async () => {
			const reserve = mock(async () => {
				throw new Error("EACCES: permission denied, open");
			});
			const store = composePendingRotationStores({
				slots: fakeSlots({ reserve }),
				legacy: fakeLegacy(),
				log: makeLog(),
				now: () => 1_000,
				reserveRetryMs: 5_000,
			});

			await expect(store.reserve("account-1")).rejects.toThrow("EACCES");
			await expect(store.reserve("account-1")).rejects.toThrow("EACCES");
			expect(reserve).toHaveBeenCalledTimes(2);
		});

		it("a discarded account starts without a held-back reservation", async () => {
			let full = true;
			const reserve = mock(async () => {
				if (full) throw storageFull();
			});
			const store = composePendingRotationStores({
				slots: fakeSlots({ reserve }),
				legacy: fakeLegacy(),
				log: makeLog(),
				now: () => 1_000,
				reserveRetryMs: 5_000,
			});

			await expect(store.reserve("account-1")).rejects.toBeDefined();
			await store.discard("account-1");
			full = false;

			await expect(store.reserve("account-1")).resolves.toBeUndefined();
		});
	});
});
