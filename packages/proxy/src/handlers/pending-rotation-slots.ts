import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes,
} from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import { isStorageFullError } from "@better-ccflare/core";
import type { PendingRotation } from "./pending-rotation-registry";
import { assertPendingRotation } from "./pending-rotation-wal";

/*
 * Fixed-size pending-rotation slots.
 *
 * The temp-file-and-rename `.wal` store needs fresh disk blocks for every save,
 * so on a full disk a rotated refresh token cannot be saved. A slot is
 * written out in full once, while there is space, and every later save
 * overwrites it in place: no truncate, no rename, no unlink, so no block is
 * ever released for another writer to take.
 *
 * That holds on a filesystem that overwrites a file's blocks where they are
 * (measured on ext4 and tmpfs). One that allocates new blocks on every write
 * (btrfs, ZFS), or that keeps a run of zeros in no blocks at all, can still
 * fail a save for lack of space. The refresh then fails the way it did before
 * slots.
 *
 * The file holds two records (A and B). A save writes the record that is not
 * current, with a higher sequence, so a write cut short leaves the previous
 * record current.
 *
 * Concurrency: calls for one account are serialized by the caller (the
 * pending-rotation registry). Every method does its file and crypto work
 * synchronously, so nothing interleaves between reading a slot and writing it.
 */

export const SLOT_RECORD_BYTES = 32 * 1024;
export const SLOT_FILE_BYTES = 2 * SLOT_RECORD_BYTES;

const SLOT_PREFIX = "pending-rotation-";
const SLOT_SUFFIX = ".slot";
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const MAGIC = Buffer.from("PRS1", "ascii");
const SEQUENCE_BYTES = 8;
const LENGTH_BYTES = 4;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + SEQUENCE_BYTES + LENGTH_BYTES + IV_BYTES;
const MAX_CIPHERTEXT_BYTES = SLOT_RECORD_BYTES - HEADER_BYTES;

/** The rotation does not fit a slot record. Nothing was written. */
export class PendingRotationTooLargeError extends Error {
	readonly code = "PENDING_ROTATION_TOO_LARGE";
	constructor(message = "pending rotation does not fit a slot record") {
		super(message);
		this.name = "PendingRotationTooLargeError";
	}
}

export interface PendingRotationSlotStoreOptions {
	directory: string;
	secret: string;
	/** A slot that cannot be read at load. The slot is skipped. */
	onUnreadableSlot?: (fileName: string, error: unknown) => void;
}

export interface PendingRotationSlotStore {
	reserve(accountId: string): Promise<void>;
	save(accountId: string, rotation: PendingRotation): Promise<void>;
	clear(accountId: string): Promise<void>;
	discard(accountId: string): Promise<void>;
	load(): Promise<Array<{ accountId: string; rotation: PendingRotation }>>;
}

interface SlotPayload {
	accountId: string;
	state: "pending" | "cleared";
	rotation?: PendingRotation;
}

interface ValidRecord {
	offset: number;
	sequence: bigint;
	payload: SlotPayload;
}

function digestBytes(accountId: string): Buffer {
	return createHash("sha256").update(accountId).digest();
}

function slotFileName(accountId: string): string {
	return `${SLOT_PREFIX}${digestBytes(accountId).toString("hex")}${SLOT_SUFFIX}`;
}

function parseFileDigest(fileName: string): string | null {
	if (!fileName.startsWith(SLOT_PREFIX) || !fileName.endsWith(SLOT_SUFFIX)) {
		return null;
	}
	const digest = fileName.slice(SLOT_PREFIX.length, -SLOT_SUFFIX.length);
	return HEX_SHA256.test(digest) ? digest : null;
}

function deriveKey(secret: string): Buffer {
	if (!secret) throw new Error("pending rotation slot secret is empty");
	return createHash("sha256")
		.update("better-ccflare/pending-rotation-slot/v1\0")
		.update(secret)
		.digest();
}

function sequenceBytes(sequence: bigint): Buffer {
	const buf = Buffer.alloc(SEQUENCE_BYTES);
	buf.writeBigUInt64BE(sequence);
	return buf;
}

function additionalData(sequence: Buffer, digest: Buffer): Buffer {
	return Buffer.concat([MAGIC, sequence, digest]);
}

function fsyncPath(path: string): void {
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function encodePayload(payload: SlotPayload): Buffer {
	return Buffer.from(JSON.stringify(payload), "utf8");
}

function assertFits(plaintext: Buffer): void {
	if (plaintext.length + TAG_BYTES > MAX_CIPHERTEXT_BYTES) {
		throw new PendingRotationTooLargeError();
	}
}

function buildRecord(
	key: Buffer,
	digest: Buffer,
	sequence: bigint,
	plaintext: Buffer,
): Buffer {
	assertFits(plaintext);
	const seq = sequenceBytes(sequence);
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	cipher.setAAD(additionalData(seq, digest));
	const ciphertext = Buffer.concat([
		cipher.update(plaintext),
		cipher.final(),
		cipher.getAuthTag(),
	]);
	const length = Buffer.alloc(LENGTH_BYTES);
	length.writeUInt32BE(ciphertext.length);
	const record = Buffer.alloc(SLOT_RECORD_BYTES);
	Buffer.concat([MAGIC, seq, length, iv, ciphertext]).copy(record);
	return record;
}

function readRecord(
	key: Buffer,
	digest: Buffer,
	file: Buffer,
	offset: number,
): ValidRecord | null {
	try {
		const record = file.subarray(offset, offset + SLOT_RECORD_BYTES);
		if (record.length !== SLOT_RECORD_BYTES) return null;
		if (!record.subarray(0, MAGIC.length).equals(MAGIC)) return null;
		const seqBytes = record.subarray(
			MAGIC.length,
			MAGIC.length + SEQUENCE_BYTES,
		);
		const lengthAt = MAGIC.length + SEQUENCE_BYTES;
		const length = record.readUInt32BE(lengthAt);
		if (length < TAG_BYTES || length > MAX_CIPHERTEXT_BYTES) return null;
		const iv = record.subarray(lengthAt + LENGTH_BYTES, HEADER_BYTES);
		const body = record.subarray(HEADER_BYTES, HEADER_BYTES + length);
		const decipher = createDecipheriv("aes-256-gcm", key, iv);
		decipher.setAAD(additionalData(Buffer.from(seqBytes), digest));
		decipher.setAuthTag(body.subarray(length - TAG_BYTES));
		const plaintext = Buffer.concat([
			decipher.update(body.subarray(0, length - TAG_BYTES)),
			decipher.final(),
		]);
		const parsed = JSON.parse(
			plaintext.toString("utf8"),
		) as Partial<SlotPayload>;
		if (typeof parsed.accountId !== "string") return null;
		if (!digestBytes(parsed.accountId).equals(digest)) return null;
		if (parsed.state === "cleared") {
			if (parsed.rotation !== undefined) return null;
			return {
				offset,
				sequence: seqBytes.readBigUInt64BE(),
				payload: { accountId: parsed.accountId, state: "cleared" },
			};
		}
		if (parsed.state !== "pending") return null;
		return {
			offset,
			sequence: seqBytes.readBigUInt64BE(),
			payload: {
				accountId: parsed.accountId,
				state: "pending",
				rotation: assertPendingRotation(parsed.rotation),
			},
		};
	} catch {
		return null;
	}
}

function currentRecord(
	key: Buffer,
	digest: Buffer,
	file: Buffer,
): ValidRecord | null {
	if (file.length !== SLOT_FILE_BYTES) return null;
	let best: ValidRecord | null = null;
	for (const offset of [0, SLOT_RECORD_BYTES]) {
		const candidate = readRecord(key, digest, file, offset);
		if (candidate && (!best || candidate.sequence > best.sequence)) {
			best = candidate;
		}
	}
	return best;
}

export function createPendingRotationSlotStore(
	options: PendingRotationSlotStoreOptions,
): PendingRotationSlotStore {
	const ensureDirectory = (): void => {
		mkdirSync(options.directory, { recursive: true, mode: 0o700 });
		chmodSync(options.directory, 0o700);
	};
	// The server builds this store at start. A directory that cannot be made for
	// lack of space must not stop that start: `reserve` makes it again, and its
	// failure reaches the refresh that asked.
	try {
		ensureDirectory();
	} catch (error) {
		if (!isStorageFullError(error)) throw error;
	}
	const key = deriveKey(options.secret);

	const pathFor = (accountId: string) =>
		join(options.directory, slotFileName(accountId));

	const hasFullSlot = (path: string): boolean => {
		try {
			return statSync(path).size === SLOT_FILE_BYTES;
		} catch (error) {
			// Only a missing file means there is no slot. Any other failure says
			// nothing about what the path holds, and a slot made on that guess
			// would be renamed over one that may hold a rotation.
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
	};

	const reserveSync = (accountId: string): void => {
		const path = pathFor(accountId);
		if (hasFullSlot(path)) return;
		if (!existsSync(options.directory)) ensureDirectory();
		const digest = digestBytes(accountId);
		const image = Buffer.alloc(SLOT_FILE_BYTES);
		buildRecord(
			key,
			digest,
			1n,
			encodePayload({ accountId, state: "cleared" }),
		).copy(image, 0);
		const tempPath = `${path}.${crypto.randomUUID()}.tmp`;
		try {
			writeFileSync(tempPath, image, { mode: 0o600 });
			fsyncPath(tempPath);
			renameSync(tempPath, path);
			chmodSync(path, 0o600);
			fsyncPath(options.directory);
		} finally {
			rmSync(tempPath, { force: true });
		}
	};

	// Overwrites the record that is not current, in place. Never truncates.
	const writeInPlace = (accountId: string, payload: SlotPayload): void => {
		const path = pathFor(accountId);
		const digest = digestBytes(accountId);
		const plaintext = encodePayload(payload);
		assertFits(plaintext);
		reserveSync(accountId);
		const current = currentRecord(key, digest, readFileSync(path));
		const sequence = current ? current.sequence + 1n : 1n;
		const offset = current && current.offset === 0 ? SLOT_RECORD_BYTES : 0;
		const record = buildRecord(key, digest, sequence, plaintext);
		const fd = openSync(path, "r+");
		try {
			const written = writeSync(fd, record, 0, record.length, offset);
			if (written !== record.length) {
				throw new Error("short write to pending rotation slot");
			}
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	};

	return {
		async reserve(accountId): Promise<void> {
			reserveSync(accountId);
		},

		async save(accountId, rotation): Promise<void> {
			writeInPlace(accountId, { accountId, state: "pending", rotation });
		},

		async clear(accountId): Promise<void> {
			if (!existsSync(pathFor(accountId))) return;
			writeInPlace(accountId, { accountId, state: "cleared" });
		},

		async discard(accountId): Promise<void> {
			if (!existsSync(options.directory)) return;
			rmSync(pathFor(accountId), { force: true });
			fsyncPath(options.directory);
		},

		async load(): Promise<
			Array<{ accountId: string; rotation: PendingRotation }>
		> {
			const entries: Array<{ accountId: string; rotation: PendingRotation }> =
				[];
			if (!existsSync(options.directory)) return entries;
			for (const fileName of readdirSync(options.directory).sort()) {
				const hex = parseFileDigest(fileName);
				if (hex === null) continue;
				try {
					const file = readFileSync(join(options.directory, fileName));
					if (file.length !== SLOT_FILE_BYTES) {
						throw new Error(
							`pending rotation slot has ${file.length} bytes, expected ${SLOT_FILE_BYTES}`,
						);
					}
					const current = currentRecord(key, Buffer.from(hex, "hex"), file);
					if (!current) {
						throw new Error("pending rotation slot has no valid record");
					}
					if (current.payload.state === "cleared") continue;
					entries.push({
						accountId: current.payload.accountId,
						rotation: current.payload.rotation as PendingRotation,
					});
				} catch (error) {
					options.onUnreadableSlot?.(fileName, error);
				}
			}
			return entries;
		},
	};
}
