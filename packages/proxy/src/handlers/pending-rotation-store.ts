import { existsSync } from "node:fs";
import { isStorageFullError } from "@hov-router/core";
import { Logger } from "@hov-router/logger";
import type {
	PendingRotation,
	PendingRotationPersistence,
} from "./pending-rotation-registry";
import {
	createPendingRotationSlotStore,
	type PendingRotationSlotStore,
} from "./pending-rotation-slots";

/*
 * The pending-rotation store the server runs with (#827).
 *
 * Rotations are written to a fixed-size slot per account, which a save
 * overwrites in place, so a save works on a full disk once the slot exists.
 * Slots are the only persistence format read or written.
 */

/** How long a reservation that failed for lack of space is not tried again. */
export const RESERVE_RETRY_MS = 5_000;

/** Matches `@hov-router/logger`'s `Logger`: a message and at most one data value. */
export interface PendingRotationStoreLog {
	info(message: string, data?: unknown): void;
	warn(message: string, data?: unknown): void;
	error(message: string, data?: unknown): void;
}

export type PendingRotationStore = Required<PendingRotationPersistence>;

export interface ComposePendingRotationStoresOptions {
	slots: PendingRotationSlotStore;
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
	const { slots } = options;
	const now = options.now ?? Date.now;
	const reserveRetryMs = options.reserveRetryMs ?? RESERVE_RETRY_MS;

	// Creating a slot writes 64 KiB. On a full disk that fails every time, and a
	// refresh asks for a reservation on every attempt, so a failure for lack of
	// space is remembered per account for a few seconds.
	const heldBack = new Map<string, { retryAt: number; error: unknown }>();

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
		},

		async remove(accountId): Promise<void> {
			await slots.clear(accountId);
		},

		async discard(accountId): Promise<void> {
			heldBack.delete(accountId);
			await slots.discard(accountId);
		},

		async load(): Promise<Entry[]> {
			return slots.load();
		},
	};
}

export function createPendingRotationStore(
	options: PendingRotationStoreOptions,
): PendingRotationStore {
	const log = options.log ?? new Logger("PendingRotationStore");
	const slots = createPendingRotationSlotStore({
		directory: options.directory,
		secret: options.secret,
		onUnreadableSlot: (fileName, error) =>
			log.error(
				`Pending rotation slot ${fileName} cannot be read and was skipped`,
				error,
			),
	});
	// The slot store carries on without a directory it could not make for
	// lack of space; nothing else tells the operator why rotations fail.
	if (!existsSync(options.directory)) {
		log.error(
			`The pending rotation directory ${options.directory} could not be made for lack of space; token refreshes that rotate a refresh token are refused until it can`,
		);
	}
	return composePendingRotationStores({ slots });
}
