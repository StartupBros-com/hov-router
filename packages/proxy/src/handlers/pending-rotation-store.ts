import { existsSync } from "node:fs";
import { isStorageFullError } from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import type {
	PendingRotation,
	PendingRotationPersistence,
} from "./pending-rotation-registry";
import {
	createPendingRotationSlotStore,
	type PendingRotationSlotStore,
} from "./pending-rotation-slots";
import { createPendingRotationWal } from "./pending-rotation-wal";

/*
 * The pending-rotation store the server runs with (#827).
 *
 * Rotations are written to a fixed-size slot per account, which a save
 * overwrites in place, so a save works on a full disk once the slot exists.
 * The older `.wal` files are still read at load, so a rotation saved by an
 * earlier build survives the upgrade, and are removed once a slot holds the
 * account's current rotation. Nothing writes a `.wal` file any more.
 */

/** How long a reservation that failed for lack of space is not tried again. */
export const RESERVE_RETRY_MS = 5_000;

/** Matches `@better-ccflare/logger`'s `Logger`: a message and at most one data value. */
export interface PendingRotationStoreLog {
	info(message: string, data?: unknown): void;
	warn(message: string, data?: unknown): void;
	error(message: string, data?: unknown): void;
}

export type PendingRotationStore = Required<PendingRotationPersistence>;

export interface ComposePendingRotationStoresOptions {
	slots: PendingRotationSlotStore;
	legacy: PendingRotationPersistence;
	log?: PendingRotationStoreLog;
	now?: () => number;
	reserveRetryMs?: number;
}

export interface PendingRotationStoreOptions {
	directory: string;
	secret: string;
	log?: PendingRotationStoreLog;
}

type Entry = { accountId: string; rotation: PendingRotation };

export function composePendingRotationStores(
	options: ComposePendingRotationStoresOptions,
): PendingRotationStore {
	const { slots, legacy } = options;
	const log = options.log ?? new Logger("PendingRotationStore");
	const now = options.now ?? Date.now;
	const reserveRetryMs = options.reserveRetryMs ?? RESERVE_RETRY_MS;

	// Creating a slot writes 64 KiB. On a full disk that fails every time, and a
	// refresh asks for a reservation on every attempt, so a failure for lack of
	// space is remembered per account for a few seconds.
	const heldBack = new Map<string, { retryAt: number; error: unknown }>();

	// The slot already holds the account's current rotation when this runs, so a
	// legacy file that cannot be removed costs nothing but a later retry.
	const removeSupersededLegacy = async (accountId: string): Promise<void> => {
		try {
			await legacy.remove(accountId);
		} catch (error) {
			log.warn(
				`Could not remove the legacy pending rotation file for account ${accountId}; its slot holds the current rotation`,
				error,
			);
		}
	};

	return {
		async reserve(accountId): Promise<void> {
			const held = heldBack.get(accountId);
			if (held && now() < held.retryAt) throw held.error;
			try {
				await slots.reserve(accountId);
				heldBack.delete(accountId);
			} catch (error) {
				if (isStorageFullError(error)) {
					heldBack.set(accountId, { retryAt: now() + reserveRetryMs, error });
				} else {
					heldBack.delete(accountId);
				}
				throw error;
			}
		},

		async save(accountId, rotation): Promise<void> {
			await slots.save(accountId, rotation);
			heldBack.delete(accountId);
			await removeSupersededLegacy(accountId);
		},

		async remove(accountId): Promise<void> {
			// The legacy file goes first. If it cannot be removed the slot keeps
			// its rotation, which is the newer of the two, and the next load puts
			// the slot ahead of the file. Cleared first, the slot would leave that
			// load nothing but the older rotation to restore.
			await legacy.remove(accountId);
			await slots.clear(accountId);
		},

		async discard(accountId): Promise<void> {
			heldBack.delete(accountId);
			await slots.discard(accountId);
			await legacy.remove(accountId);
		},

		async load(): Promise<Entry[]> {
			const entries: Entry[] = await slots.load();
			const inSlots = new Set(entries.map((entry) => entry.accountId));
			for (const entry of await legacy.load()) {
				if (inSlots.has(entry.accountId)) {
					log.info(
						`Dropping the legacy pending rotation file for account ${entry.accountId}: its slot holds a newer rotation`,
					);
					await removeSupersededLegacy(entry.accountId);
					continue;
				}
				entries.push(entry);
			}
			return entries;
		},
	};
}

// Stands in for the `.wal` store when its directory does not exist. Nothing
// writes a `.wal` file any more, so none can appear later.
const noLegacyFiles: PendingRotationPersistence = {
	async save(): Promise<void> {
		throw new Error("legacy pending rotation files are read-only");
	},
	async load(): Promise<Entry[]> {
		return [];
	},
	async remove(): Promise<void> {},
};

export function createPendingRotationStore(
	options: PendingRotationStoreOptions,
): PendingRotationStore {
	const log = options.log ?? new Logger("PendingRotationStore");
	// The slot store makes the directory, and carries on without it when there
	// is no space to make it. The `.wal` store would fail the start instead.
	const slots = createPendingRotationSlotStore({
		directory: options.directory,
		secret: options.secret,
		onUnreadableSlot: (fileName, error) =>
			log.error(
				`Pending rotation slot ${fileName} cannot be read and was skipped`,
				error,
			),
	});
	const legacy = existsSync(options.directory)
		? createPendingRotationWal({
				directory: options.directory,
				secret: options.secret,
			})
		: noLegacyFiles;
	if (legacy === noLegacyFiles) {
		log.error(
			`The pending rotation directory ${options.directory} could not be made for lack of space; token refreshes that rotate a refresh token are refused until it can`,
		);
	}
	return composePendingRotationStores({ slots, legacy, log });
}
