/**
 * A provider that rotates the refresh token commits the rotation before the
 * router can store it. When the database write then fails, the rotation goes
 * to the account's slot, and a slot can only be made while there is disk
 * space. So a refresh for such an account first makes sure the slot exists,
 * and is refused, without calling the provider, when it cannot be made for
 * lack of space (#827).
 *
 * These drive the real Codex provider with global.fetch mocked, like
 * token-manager-real-provider-refresh.test.ts, so "the provider was not
 * called" means no token request left the process.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Account } from "@better-ccflare/types";
import {
	clearAllPendingRotationsForTests,
	configurePendingRotationPersistence,
	getPendingRotation,
	restorePendingRotations,
} from "../pending-rotation-registry";
import { createPendingRotationStore } from "../pending-rotation-store";
import {
	getRefreshTokenUsedForFailure,
	getValidAccessToken,
	isTerminalTokenRefreshFailure,
	RefreshStorageUnavailableError,
} from "../token-manager";

const CREATED_AT = 101;

function makeAccount(id: string, provider: string): Account {
	return {
		id,
		name: id,
		provider,
		api_key: null,
		refresh_token: "rt-old",
		access_token: "at-old",
		expires_at: 1,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: CREATED_AT,
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		requires_reauth: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		peak_hours_pause_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		consecutive_rate_limits: 0,
	};
}

/** A context whose database holds `stored` as the account's durable row. */
function makeContext(stored: Account, provider?: unknown) {
	let current: Account = { ...stored };
	const dbOps = {
		getAccount: mock(async (accountId: string) =>
			accountId === current.id ? { ...current } : null,
		),
		updateAccountTokensIfRefreshTokenMatches: mock(async () => true),
		updateAccountTokensIfRefreshTokenAbsent: mock(async () => true),
		flagRequiresReauthIfTokenMatches: mock(async () => true),
		pauseAccountIfActive: mock(async () => true),
		setRequiresReauth: mock(async () => {}),
	};
	return {
		ctx: {
			dbOps,
			provider,
			runtime: { port: 8080, clientId: "test-client" },
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) },
		},
		dbOps,
		/** Overwrite the durable row, as another consumer's rotation would. */
		store: (patch: Partial<Account>) => {
			current = { ...current, ...patch };
		},
	};
}

function mockTokenEndpoint(onCall: () => void = () => {}) {
	const fetchMock = mock(async () => {
		onCall();
		return new Response(
			JSON.stringify({
				access_token: "fresh-access",
				refresh_token: "fresh-refresh",
				expires_in: 3600,
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	});
	global.fetch = fetchMock as unknown as typeof fetch;
	return fetchMock;
}

function storageFull(): Error {
	return Object.assign(new Error("ENOSPC: no space left on device, write"), {
		code: "ENOSPC",
	});
}

function useStore(reserve: (accountId: string) => Promise<void>) {
	const store = {
		save: mock(async () => {}),
		load: mock(async () => []),
		remove: mock(async () => {}),
		reserve: mock(reserve),
	};
	configurePendingRotationPersistence(store);
	return store;
}

const originalFetch = global.fetch;
beforeEach(() => {
	clearAllPendingRotationsForTests();
	configurePendingRotationPersistence(null);
});
afterEach(() => {
	global.fetch = originalFetch;
	clearAllPendingRotationsForTests();
	configurePendingRotationPersistence(null);
});

describe("a refresh that would rotate the refresh token", () => {
	it("reserves the account's slot before calling the provider", async () => {
		const account = makeAccount("slot-first", "codex");
		const { ctx } = makeContext(account);
		const order: string[] = [];
		const store = useStore(async () => {
			order.push("reserve");
		});
		mockTokenEndpoint(() => order.push("provider"));

		await expect(getValidAccessToken(account, ctx as never)).resolves.toBe(
			"fresh-access",
		);

		expect(store.reserve).toHaveBeenCalledWith("slot-first");
		expect(order).toEqual(["reserve", "provider"]);
	});

	it("is refused without calling the provider when the slot cannot be made for lack of space", async () => {
		const account = makeAccount("slot-refused", "codex");
		const { ctx, dbOps } = makeContext(account);
		useStore(async () => {
			throw storageFull();
		});
		const fetchMock = mockTokenEndpoint();

		let refusal: unknown;
		try {
			await getValidAccessToken(account, ctx as never);
		} catch (error) {
			refusal = error;
		}

		expect(refusal).toBeInstanceOf(RefreshStorageUnavailableError);
		expect((refusal as RefreshStorageUnavailableError).statusCode).toBe(503);
		expect(fetchMock).not.toHaveBeenCalled();
		// Not the account's fault: nothing may pause it or ask for a re-login.
		expect(isTerminalTokenRefreshFailure(refusal)).toBe(false);
		expect(getRefreshTokenUsedForFailure(refusal)).toBeUndefined();
		expect(dbOps.flagRequiresReauthIfTokenMatches).not.toHaveBeenCalled();
		expect(dbOps.pauseAccountIfActive).not.toHaveBeenCalled();
		expect(dbOps.setRequiresReauth).not.toHaveBeenCalled();
		expect(ctx.refreshInFlight.size).toBe(0);
		expect(account.refresh_token).toBe("rt-old");
		expect(account.access_token).toBe("at-old");
	});

	it("leaves no backoff behind: the next call refreshes once the store can make the slot", async () => {
		const account = makeAccount("slot-recovers", "codex");
		const { ctx } = makeContext(account);
		let full = true;
		useStore(async () => {
			if (full) throw storageFull();
		});
		const fetchMock = mockTokenEndpoint();

		await expect(
			getValidAccessToken(account, ctx as never),
		).rejects.toBeInstanceOf(RefreshStorageUnavailableError);

		// No clock advance: the token manager keeps nothing from a refusal. (The
		// server's store holds a failed reservation back for a few seconds; this
		// one does not.)
		full = false;
		await expect(getValidAccessToken(account, ctx as never)).resolves.toBe(
			"fresh-access",
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(account.refresh_token).toBe("fresh-refresh");
	});

	it("returns a fresher stored token instead of refusing", async () => {
		const account = makeAccount("slot-adopts", "codex");
		const { ctx, store } = makeContext(account);
		store({
			refresh_token: "rt-newer",
			access_token: "at-newer",
			expires_at: Date.now() + 3_600_000,
		});
		useStore(async () => {
			throw storageFull();
		});
		const fetchMock = mockTokenEndpoint();

		await expect(getValidAccessToken(account, ctx as never)).resolves.toBe(
			"at-newer",
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("calls the provider once for two callers when the reservation settles late", async () => {
		const account = makeAccount("slot-dedup", "codex");
		const { ctx } = makeContext(account);
		const store = useStore(
			() => new Promise<void>((resolve) => setTimeout(resolve, 10)),
		);
		const fetchMock = mockTokenEndpoint();

		// Two requests hold their own snapshots of the same account row.
		const tokens = await Promise.all([
			getValidAccessToken({ ...account }, ctx as never),
			getValidAccessToken({ ...account }, ctx as never),
		]);

		expect(tokens).toEqual(["fresh-access", "fresh-access"]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		// The reservation belongs to the shared refresh, not to each caller.
		expect(store.reserve).toHaveBeenCalledTimes(1);
	});

	it("goes ahead when the reservation fails for a reason other than space", async () => {
		const account = makeAccount("slot-other-failure", "codex");
		const { ctx } = makeContext(account);
		useStore(async () => {
			throw Object.assign(new Error("EACCES: permission denied, open"), {
				code: "EACCES",
			});
		});
		const fetchMock = mockTokenEndpoint();

		await expect(getValidAccessToken(account, ctx as never)).resolves.toBe(
			"fresh-access",
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe("a refresh for a provider that does not rotate", () => {
	it("asks for no slot and reaches the provider on a full disk", async () => {
		const account = makeAccount("no-slot-needed", "fake-refresh-provider");
		const refreshToken = mock(async () => ({
			accessToken: "echoed-access",
			expiresAt: Date.now() + 3_600_000,
			refreshToken: "rt-old",
		}));
		const { ctx } = makeContext(account, { refreshToken });
		const store = useStore(async () => {
			throw storageFull();
		});

		await expect(getValidAccessToken(account, ctx as never)).resolves.toBe(
			"echoed-access",
		);
		expect(refreshToken).toHaveBeenCalledTimes(1);
		expect(store.reserve).not.toHaveBeenCalled();
	});
});

describe("a rotated refresh token whose database write fails", () => {
	let directory: string;
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "rotation-round-trip-"));
	});
	afterEach(() => {
		rmSync(directory, { recursive: true, force: true });
	});

	const openStore = () =>
		createPendingRotationStore({ directory, secret: "round-trip-secret" });
	const slotFiles = () =>
		readdirSync(directory).filter((name) => name.endsWith(".slot"));

	it("is kept in the account's slot, restored at the next start and written to the database once that works", async () => {
		// The real store on a real directory: the provider rotates, the database
		// write fails, the process is lost, and the next one must still hold the
		// only refresh token the provider will accept.
		configurePendingRotationPersistence(openStore());
		const account = makeAccount("round-trip", "codex");
		const failing = makeContext(account);
		failing.dbOps.updateAccountTokensIfRefreshTokenMatches.mockImplementation(
			async () => {
				throw Object.assign(new Error("database or disk is full"), {
					code: "SQLITE_FULL",
				});
			},
		);
		const tokenEndpoint = mockTokenEndpoint();

		await expect(
			getValidAccessToken(account, failing.ctx as never),
		).resolves.toBe("fresh-access");
		expect(tokenEndpoint).toHaveBeenCalledTimes(1);
		expect(slotFiles()).toHaveLength(1);
		expect(
			readdirSync(directory).filter((name) => name.endsWith(".wal")),
		).toEqual([]);

		// The next process: nothing in memory, a new store over the same
		// directory, and the account row as the database still has it.
		clearAllPendingRotationsForTests();
		configurePendingRotationPersistence(openStore());
		expect(getPendingRotation("round-trip")).toBeUndefined();
		const stored = makeAccount("round-trip", "codex");
		const working = makeContext(stored);

		await expect(
			restorePendingRotations(async (accountId) =>
				working.dbOps.getAccount(accountId),
			),
		).resolves.toBe(1);
		expect(getPendingRotation("round-trip", CREATED_AT)).toMatchObject({
			accessToken: "fresh-access",
			refreshToken: "fresh-refresh",
			attemptedRefreshToken: "rt-old",
			createdAt: CREATED_AT,
		});

		// The first request after the start. The spent refresh token must not go
		// back to the provider: the restored rotation is written to the database
		// and served instead.
		const secondCall = mock(async () => {
			throw new Error("the provider must not be asked again");
		});
		global.fetch = secondCall as unknown as typeof fetch;

		await expect(
			getValidAccessToken(stored, working.ctx as never),
		).resolves.toBe("fresh-access");
		expect(secondCall).not.toHaveBeenCalled();
		expect(
			working.dbOps.updateAccountTokensIfRefreshTokenMatches,
		).toHaveBeenCalledTimes(1);
		const written = working.dbOps.updateAccountTokensIfRefreshTokenMatches.mock
			.calls[0] as unknown[];
		expect(written[0]).toBe("round-trip");
		expect(written[1]).toBe("rt-old");
		expect(written[2]).toBe("fresh-access");
		expect(written[4]).toBe("fresh-refresh");
		expect(written[5]).toBe(CREATED_AT);
		expect(stored.refresh_token).toBe("fresh-refresh");

		// Stored once in the database, the rotation leaves the slot: a later
		// start has nothing to restore.
		expect(getPendingRotation("round-trip")).toBeUndefined();
		clearAllPendingRotationsForTests();
		configurePendingRotationPersistence(openStore());
		await expect(restorePendingRotations()).resolves.toBe(0);
		expect(slotFiles()).toHaveLength(1);
	});
});
