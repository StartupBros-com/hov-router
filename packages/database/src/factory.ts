import type { RuntimeConfig } from "@better-ccflare/config";
import { registerDisposable, unregisterDisposable } from "@better-ccflare/core";
import {
	type DatabaseConfig,
	DatabaseOperations,
	type DatabaseRetryConfig,
} from "./database-operations";
import { resolveDbPath } from "./paths";
import { assertNotPostgresUrl } from "./postgres-refusal";
import { openWithStartReserve } from "./start-reserve";

let instance: DatabaseOperations | null = null;
let closing: Promise<void> | null = null;
let dbPath: string | undefined;
let runtimeConfig: RuntimeConfig | undefined;

export function initialize(
	dbPathParam?: string,
	runtimeConfigParam?: RuntimeConfig,
): void {
	if (closing)
		throw new Error(
			"Database owner retiring; await closeAll() before initializing",
		);
	// The open database keeps the path and runtime config it was built with,
	// so new ones here would be silently ignored. The CLI's --serve path once
	// opened it before the server passed its config, and production ran
	// synchronous=FULL with mmap off instead of the configured values (#606).
	if (
		instance &&
		(dbPathParam !== dbPath || runtimeConfigParam !== runtimeConfig)
	)
		throw new Error(
			"Database already open with a different path or runtime config; initialize before the first getInstance()",
		);
	dbPath = dbPathParam;
	runtimeConfig = runtimeConfigParam;
}

export function getInstance(): DatabaseOperations {
	if (closing)
		throw new Error(
			"Database owner retiring; await closeAll() before replacement",
		);
	if (!instance) {
		assertNotPostgresUrl();
		// Extract database configuration from runtime config
		const dbConfig: DatabaseConfig | undefined = runtimeConfig?.database
			? {
					...(runtimeConfig.database.walMode !== undefined && {
						walMode: runtimeConfig.database.walMode,
					}),
					...(runtimeConfig.database.busyTimeoutMs !== undefined && {
						busyTimeoutMs: runtimeConfig.database.busyTimeoutMs,
					}),
					...(runtimeConfig.database.cacheSize !== undefined && {
						cacheSize: runtimeConfig.database.cacheSize,
					}),
					...(runtimeConfig.database.synchronous !== undefined && {
						synchronous: runtimeConfig.database.synchronous,
					}),
					...(runtimeConfig.database.mmapSize !== undefined && {
						mmapSize: runtimeConfig.database.mmapSize,
					}),
					...(runtimeConfig.database.pageSize !== undefined && {
						pageSize: runtimeConfig.database.pageSize,
					}),
				}
			: undefined;

		const retryConfig: DatabaseRetryConfig | undefined =
			runtimeConfig?.database?.retry;

		instance = new DatabaseOperations(dbPath, dbConfig, retryConfig);
		if (runtimeConfig) {
			instance.setRuntimeConfig(runtimeConfig);
		}
		// Register with lifecycle manager
		registerDisposable(instance);
	}
	return instance;
}

/**
 * Get or create the database instance, running async initialization.
 * Use this in server startup code where async is available.
 */
export async function getInstanceAsync(): Promise<DatabaseOperations> {
	const db = getInstance();
	// Start the multi-instance guard and heartbeat
	await db.initializeAsync();
	return db;
}

/**
 * `getInstanceAsync` for the server's start: an open that fails for lack of
 * space releases the start reserve and is tried once more (#827).
 *
 * Only the server opens the database this way. CLI commands keep
 * `getInstance`, so a command run on a full disk cannot spend the reserve the
 * next server start depends on.
 */
export async function getInstanceForServerStart(
	onReserveReleased?: (bytes: number, error: unknown) => void,
): Promise<DatabaseOperations> {
	const db = openWithStartReserve(
		dbPath ?? resolveDbPath(),
		() => getInstance(),
		onReserveReleased,
	);
	await db.initializeAsync();
	return db;
}

/** Keep the singleton registered until every database owner has retired. */
export function closeAll(): Promise<void> {
	if (closing) return closing;
	if (!instance) return Promise.resolve();
	const retiringInstance = instance;
	closing = retiringInstance.close().then(() => {
		unregisterDisposable(retiringInstance);
		instance = null;
		closing = null;
	});
	// On ambiguous retirement, keep the failed promise and owner fenced until
	// process reap rather than opening another connection over a live worker.
	return closing;
}

export function reset(): Promise<void> {
	return closeAll();
}

export const DatabaseFactory = {
	initialize,
	getInstance,
	getInstanceAsync,
	getInstanceForServerStart,
	closeAll,
	reset,
};
