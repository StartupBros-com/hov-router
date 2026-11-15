/**
 * Shared pieces of the full-filesystem scenarios: the guard that keeps them on
 * a small filesystem mounted for the purpose, and the writers that fill it.
 */
import { closeSync, openSync, statfsSync, statSync, writeSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname } from "node:path";

export function freeBytes(dir: string): number {
	const stats = statfsSync(dir);
	return Number(stats.bavail) * Number(stats.bsize);
}

/**
 * Free blocks and the ones an ordinary write may take. On ext4 the first stays
 * above zero when the second is zero: the difference is held back for root
 * and for the filesystem's own bookkeeping.
 */
export function blockCounts(dir: string): { free: number; available: number } {
	const stats = statfsSync(dir);
	return { free: Number(stats.bfree), available: Number(stats.bavail) };
}

/** Largest filesystem a scenario agrees to fill. */
export const MAX_SCENARIO_FILESYSTEM_BYTES = 1 << 30;

/**
 * The fill phase writes until nothing is left, so it must only ever run on a
 * small filesystem mounted for it. Pointed at an ordinary directory it would
 * fill the host's disk, which is the outage these scenarios exist to prevent.
 */
export function assertDedicatedSmallMount(dir: string): void {
	if (statSync(dir).dev === statSync(dirname(dir)).dev) {
		throw new Error(
			`${dir} is not a mount point; mount a size-capped tmpfs there first`,
		);
	}
	const stats = statfsSync(dir);
	const total = Number(stats.blocks) * Number(stats.bsize);
	if (total > MAX_SCENARIO_FILESYSTEM_BYTES) {
		throw new Error(
			`${dir} is ${total} bytes; the scenario only fills filesystems up to ${MAX_SCENARIO_FILESYSTEM_BYTES} bytes`,
		);
	}
}

/**
 * A scenario that stores a made-up OAuth account must not be able to reach
 * the provider that account names: a server that used the row would send its
 * made-up token there. So such a scenario only runs where this process can
 * reach nothing but itself, in a network namespace whose only interface is
 * loopback (`unshare -n`, then `ip link set lo up`).
 */
export function assertLoopbackOnly(): void {
	const others = Object.keys(networkInterfaces()).filter(
		(name) => name !== "lo",
	);
	if (others.length > 0) {
		throw new Error(
			`this process can reach ${others.join(", ")}; an OAuth account row only goes in inside a network namespace with nothing but loopback`,
		);
	}
}

/**
 * Append to the ballast file until the filesystem has no free block left.
 * Called repeatedly, it plays the co-tenant that takes back anything the
 * router frees (a truncated WAL, a rotated log).
 */
export function fillToZero(ballastPath: string): number {
	const fd = openSync(ballastPath, "a");
	let written = 0;
	try {
		for (const size of [1 << 20, 4096]) {
			const chunk = Buffer.alloc(size, 0x62);
			while (true) {
				let count = 0;
				try {
					count = writeSync(fd, chunk);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOSPC") break;
					throw error;
				}
				if (count === 0) break;
				written += count;
			}
		}
	} finally {
		closeSync(fd);
	}
	return written;
}

/**
 * The `--spin <file> <pause µs>` child: retries a 4 KiB append forever. With
 * no pause it plays a co-tenant that never backs off, which is the worst case
 * for anything that releases a block and expects to get it back.
 */
export function spinForever(path: string, pauseUs: number): never {
	assertDedicatedSmallMount(dirname(path));
	const fd = openSync(path, "a");
	const chunk = Buffer.alloc(4096, 0x73);
	while (true) {
		try {
			writeSync(fd, chunk);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOSPC") throw error;
		}
		if (pauseUs > 0) Bun.sleepSync(pauseUs / 1000);
	}
}
