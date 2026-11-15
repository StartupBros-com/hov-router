import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	copyFileSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createPendingRotationSlotStore,
	PendingRotationTooLargeError,
	SLOT_FILE_BYTES,
	SLOT_RECORD_BYTES,
} from "../pending-rotation-slots";

const SECRET = "pending-rotation-slot-test-secret-with-enough-entropy";
const rotation = {
	accessToken: "access-secret",
	expiresAt: 2_000_000_000_000,
	refreshToken: "refresh-secret",
	attemptedRefreshToken: "consumed-secret",
	createdAt: 1_600_000_000_000,
	recordedAt: 1_700_000_000_000,
};

let directory: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "better-ccflare-pending-slots-"));
});

afterEach(() => {
	try {
		chmodSync(directory, 0o700);
	} catch {}
	rmSync(directory, { recursive: true, force: true });
});

function slotName(accountId: string): string {
	return `pending-rotation-${createHash("sha256").update(accountId).digest("hex")}.slot`;
}

function slotPath(accountId: string): string {
	return join(directory, slotName(accountId));
}

function identity(path: string) {
	const s = statSync(path);
	return { size: s.size, ino: s.ino, blocks: s.blocks };
}

function overwrite(path: string, offset: number, bytes: Buffer) {
	const fd = openSync(path, "r+");
	try {
		writeSync(fd, bytes, 0, bytes.length, offset);
	} finally {
		closeSync(fd);
	}
}

function open(
	onUnreadableSlot?: (f: string, e: unknown) => void,
	secret = SECRET,
) {
	return createPendingRotationSlotStore({
		directory,
		secret,
		onUnreadableSlot,
	});
}

describe("pending rotation slots", () => {
	it("reserve creates a full-size 0600 file and is idempotent", async () => {
		const store = open();
		await store.reserve("account-1");
		const path = slotPath("account-1");
		const s = statSync(path);
		expect(s.size).toBe(SLOT_FILE_BYTES);
		expect(s.mode & 0o777).toBe(0o600);
		expect(s.blocks * 512).toBeGreaterThanOrEqual(SLOT_FILE_BYTES);

		const before = statSync(path);
		await Bun.sleep(15);
		await store.reserve("account-1");
		const after = statSync(path);
		expect(after.ino).toBe(before.ino);
		expect(after.mtimeMs).toBe(before.mtimeMs);
	});

	it("round-trips a rotation, with and without optional fields", async () => {
		const store = open();
		await store.save("account-1", rotation);
		expect(await open().load()).toEqual([{ accountId: "account-1", rotation }]);
		const minimal = {
			accessToken: "a",
			expiresAt: 1,
			attemptedRefreshToken: "b",
			recordedAt: 2,
		};
		await store.save("account-1", minimal);
		expect(await open().load()).toEqual([
			{ accountId: "account-1", rotation: minimal },
		]);
	});

	it("keeps size, inode and blocks across 50 saves", async () => {
		const store = open();
		await store.reserve("account-1");
		const before = identity(slotPath("account-1"));
		let last = rotation;
		for (let i = 0; i < 50; i++) {
			last = { ...rotation, accessToken: `access-${i}`, recordedAt: i };
			await store.save("account-1", last);
		}
		expect(await store.load()).toEqual([
			{ accountId: "account-1", rotation: last },
		]);
		expect(identity(slotPath("account-1"))).toEqual(before);
		expect(readdirSync(directory)).toEqual([slotName("account-1")]);
	});

	it("clear keeps the file and a later save loads again", async () => {
		const store = open();
		await store.save("account-1", rotation);
		const before = identity(slotPath("account-1"));
		await store.clear("account-1");
		expect(await store.load()).toEqual([]);
		expect(identity(slotPath("account-1"))).toEqual(before);
		await store.save("account-1", rotation);
		expect(await store.load()).toEqual([{ accountId: "account-1", rotation }]);
		expect(identity(slotPath("account-1"))).toEqual(before);
	});

	it("clear and discard without a slot create nothing", async () => {
		const store = open();
		await store.clear("account-1");
		await store.discard("account-1");
		expect(readdirSync(directory)).toEqual([]);
	});

	it("a torn newest record falls back to the previous one", async () => {
		const store = open();
		await store.save("account-1", { ...rotation, accessToken: "r1" });
		await store.save("account-1", { ...rotation, accessToken: "r2" });
		const path = slotPath("account-1");
		const bytes = readFileSync(path);
		const seq = (offset: number) => Number(bytes.readBigUInt64BE(offset + 4));
		const newer = seq(0) > seq(SLOT_RECORD_BYTES) ? 0 : SLOT_RECORD_BYTES;
		overwrite(path, newer, Buffer.alloc(SLOT_RECORD_BYTES, 0xab));
		const loaded = await open().load();
		expect(loaded).toHaveLength(1);
		expect(loaded[0]?.rotation.accessToken).toBe("r1");
	});

	it("reports a slot with two garbage records and keeps loading others", async () => {
		const calls: string[] = [];
		const store = open((f) => calls.push(f));
		await store.save("account-1", rotation);
		await store.save("account-2", { ...rotation, accessToken: "other" });
		overwrite(slotPath("account-1"), 0, Buffer.alloc(SLOT_RECORD_BYTES, 1));
		overwrite(
			slotPath("account-1"),
			SLOT_RECORD_BYTES,
			Buffer.alloc(SLOT_RECORD_BYTES, 2),
		);
		const loaded = await store.load();
		expect(calls).toEqual([slotName("account-1")]);
		expect(loaded.map((e) => e.accountId)).toEqual(["account-2"]);
	});

	it("reports a wrong-size slot and a later save replaces it", async () => {
		const calls: string[] = [];
		const store = open((f) => calls.push(f));
		writeFileSync(slotPath("account-1"), Buffer.alloc(100), { mode: 0o600 });
		expect(await store.load()).toEqual([]);
		expect(calls).toEqual([slotName("account-1")]);
		await store.save("account-1", rotation);
		expect(statSync(slotPath("account-1")).size).toBe(SLOT_FILE_BYTES);
		expect(await store.load()).toEqual([{ accountId: "account-1", rotation }]);
	});

	it("reports a slot written under another secret", async () => {
		await open().save("account-1", rotation);
		const calls: string[] = [];
		const other = open((f) => calls.push(f), "a-different-secret");
		expect(await other.load()).toEqual([]);
		expect(calls).toEqual([slotName("account-1")]);
	});

	it("binds a record to its account", async () => {
		const store = open();
		await store.save("account-1", rotation);
		copyFileSync(slotPath("account-1"), slotPath("account-2"));
		const calls: string[] = [];
		const loaded = await open((f) => calls.push(f)).load();
		expect(loaded.map((e) => e.accountId)).toEqual(["account-1"]);
		expect(calls).toEqual([slotName("account-2")]);
	});

	it("rejects an oversized rotation before writing anything", async () => {
		const store = open();
		const big = { ...rotation, accessToken: "x".repeat(40_000) };
		await expect(store.save("account-1", big)).rejects.toBeInstanceOf(
			PendingRotationTooLargeError,
		);
		expect(readdirSync(directory)).toEqual([]);

		await store.save("account-1", rotation);
		const before = identity(slotPath("account-1"));
		const bytes = readFileSync(slotPath("account-1"));
		await expect(store.save("account-1", big)).rejects.toMatchObject({
			code: "PENDING_ROTATION_TOO_LARGE",
		});
		expect(identity(slotPath("account-1"))).toEqual(before);
		expect(readFileSync(slotPath("account-1")).equals(bytes)).toBe(true);
		expect(await store.load()).toEqual([{ accountId: "account-1", rotation }]);
	});

	it("discard removes the slot", async () => {
		const store = open();
		await store.save("account-1", rotation);
		await store.discard("account-1");
		expect(readdirSync(directory)).toEqual([]);
		expect(await store.load()).toEqual([]);
	});

	it("ignores wal and unrelated files", async () => {
		const files: Record<string, string> = {
			[`pending-rotation-${"a".repeat(64)}.wal`]: "{}",
			[`pending-rotation-${"b".repeat(64)}.slot.tmp`]: "tmp",
			"notes.txt": "hello",
			"pending-rotation-short.slot": "x",
		};
		for (const [name, body] of Object.entries(files)) {
			writeFileSync(join(directory, name), body);
		}
		const calls: string[] = [];
		expect(await open((f) => calls.push(f)).load()).toEqual([]);
		expect(calls).toEqual([]);
		for (const [name, body] of Object.entries(files)) {
			expect(readFileSync(join(directory, name), "utf8")).toBe(body);
		}
	});

	it.skipIf(process.getuid?.() === 0)(
		"a failed reservation leaves nothing behind",
		async () => {
			const store = open();
			chmodSync(directory, 0o500);
			await expect(store.reserve("account-1")).rejects.toBeDefined();
			chmodSync(directory, 0o700);
			expect(readdirSync(directory)).toEqual([]);
		},
	);

	it("does not store plaintext tokens", async () => {
		await open().save("account-1", rotation);
		const bytes = readFileSync(slotPath("account-1"));
		for (const secret of [
			rotation.accessToken,
			rotation.refreshToken,
			rotation.attemptedRefreshToken,
			"account-1",
		]) {
			expect(bytes.includes(Buffer.from(secret))).toBe(false);
		}
	});
});
