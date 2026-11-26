import {
	armStartReserve,
	START_RESERVE_BYTES,
	type StartReserveArmResult,
} from "@hov-router/database";
import type { Logger } from "@hov-router/logger";

/**
 * How often the server checks that the start reserve is whole.
 *
 * A start that did not need the reserve also checks once at boot. One that
 * released it does not: it is still using those blocks (its WAL grows as it
 * comes up), and putting the reserve back at once would compete with the
 * start it just rescued.
 */
export const START_RESERVE_ARM_INTERVAL_MS = 30_000;

export interface StartReserveKeeperOptions {
	dbPath: string;
	log: Pick<Logger, "info" | "warn">;
	/** Replaces the real write in tests. */
	arm?: (dbPath: string) => Promise<StartReserveArmResult>;
	/** Told after every check whether the reserve is whole. */
	onChecked?: (armed: boolean) => void;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** What a start logs after it had to release the reserve to open the database. */
export function startReserveReleasedMessage(
	bytes: number,
	error: unknown,
): string {
	return `The database could not be opened for lack of space (${describe(error)}). Released the ${bytes}-byte start reserve and opened it on the second attempt. Another restart while the disk is full may fail: the reserve is written back only once space returns.`;
}

/**
 * One check of the start reserve (#827): write it back if it is short.
 *
 * Says so only when the answer changes, so a disk that stays full costs one
 * log line, not one every interval.
 */
export function createStartReserveKeeper(
	options: StartReserveKeeperOptions,
): () => Promise<void> {
	const arm = options.arm ?? armStartReserve;
	let lastArmed: boolean | undefined;
	return async () => {
		const result = await arm(options.dbPath);
		options.onChecked?.(result.armed);
		if (result.armed === lastArmed) return;
		lastArmed = result.armed;
		if (result.armed) {
			options.log.info(
				`The start reserve is in place (${result.bytes} bytes): one start on a full disk has space to open the database.`,
			);
			return;
		}
		options.log.warn(
			`The start reserve could not be written (${result.bytes} of ${START_RESERVE_BYTES} bytes${
				result.error === undefined ? "" : `: ${describe(result.error)}`
			}). A restart while the disk is full may fail to open the database.`,
		);
	};
}
