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
import {
	type PendingRotationSlotStore,
	SLOT_FILE_BYTES,
} from "../pending-rotation-slots";
import {
	composePendingRotationStores,
	createPendingRotationStore,
} from "../pending-rotation-store";

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
	it("saves only slots and ignores old files during save, load, remove and discard", async () => {
		const oldFile = join(
			directory,
			`pending-rotation-${digest("account-1")}.wal`,
		);
		writeFileSync(oldFile, "not an envelope");
		const store = createPendingRotationStore({ directory, secret: SECRET });
		expect(await store.load()).toEqual([]);
		await store.save("account-1", rotation("new"));
		expect(await store.load()).toEqual([
			{ accountId: "account-1", rotation: rotation("new") },
		]);
		const slot = join(directory, filesEndingWith(".slot")[0] as string);
		const inode = statSync(slot).ino;
		await store.remove("account-1");
		expect(await store.load()).toEqual([]);
		expect(statSync(slot).size).toBe(SLOT_FILE_BYTES);
		expect(statSync(slot).ino).toBe(inode);
		expect(filesEndingWith(".wal")).toHaveLength(1);
		await store.discard("account-1");
		expect(filesEndingWith(".slot")).toEqual([]);
		expect(filesEndingWith(".wal")).toHaveLength(1);
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
});

describe("pending rotation store failure handling", () => {
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

	it("propagates a slot save failure", async () => {
		const store = composePendingRotationStores({
			slots: fakeSlots({
				save: mock(async () => {
					throw storageFull();
				}),
			}),
		});
		await expect(
			store.save("account-1", rotation("new")),
		).rejects.toMatchObject({ code: "ENOSPC" });
	});

	describe("reservation that fails for lack of space", () => {
		it("is not retried for the same account until the retry delay has passed", async () => {
			let now = 1_000;
			const reserve = mock(async () => {
				throw storageFull();
			});
			const store = composePendingRotationStores({
				slots: fakeSlots({ reserve }),
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
