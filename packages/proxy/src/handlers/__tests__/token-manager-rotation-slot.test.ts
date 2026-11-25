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
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	setSystemTime,
	spyOn,
} from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "@better-ccflare/logger";
import type { Account } from "@better-ccflare/types";
import { TOKEN_REFRESH_BACKOFF_MS } from "../../constants";
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
	refreshAccessTokenSafe,
	reservePendingRotationSlots,
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
		updateAccountTokensIfRefreshTokenMatches: mock(
			async (..._args: unknown[]) => true,
		),
		updateAccountTokensIfRefreshTokenAbsent: mock(async () => true),
		flagRequiresReauthIfTokenMatches: mock(async () => true),
		pauseAccountIfActive: mock(async () => true),
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
		/** The durable row as it is now. */
		row: (): Account => ({ ...current }),
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

describe("a refused refresh for a token that has not expired yet", () => {
	// A token is renewed some time before it expires. When that early refresh
	// is refused for lack of space, the provider still takes the stored token,
	// so the request should be sent with it instead of failing over.
	const stillValid = (id: string): Account => ({
		...makeAccount(id, "codex"),
		expires_at: Date.now() + 10 * 60 * 1000,
	});
	const noSpace = () =>
		useStore(async () => {
			throw storageFull();
		});

	it("serves the stored token without calling the provider", async () => {
		const account = stillValid("refused-still-valid");
		const { ctx, dbOps } = makeContext(account);
		noSpace();
		const fetchMock = mockTokenEndpoint();

		await expect(getValidAccessToken(account, ctx as never)).resolves.toBe(
			"at-old",
		);

		expect(fetchMock).not.toHaveBeenCalled();
		expect(account.refresh_token).toBe("rt-old");
		expect(
			dbOps.updateAccountTokensIfRefreshTokenMatches,
		).not.toHaveBeenCalled();
		expect(dbOps.flagRequiresReauthIfTokenMatches).not.toHaveBeenCalled();
		expect(dbOps.pauseAccountIfActive).not.toHaveBeenCalled();
		expect(ctx.refreshInFlight.size).toBe(0);
	});

	it("still refuses a refresh asked for because the provider rejected that token", async () => {
		// The upstream-401 path asks for the refresh directly. The token it
		// holds was just turned down, so serving it again would help nobody.
		const account = stillValid("refused-after-401");
		const { ctx } = makeContext(account);
		noSpace();
		const fetchMock = mockTokenEndpoint();

		await expect(
			refreshAccessTokenSafe(account, ctx as never),
		).rejects.toBeInstanceOf(RefreshStorageUnavailableError);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("is refused once the token has expired", async () => {
		const account: Account = {
			...makeAccount("refused-just-expired", "codex"),
			expires_at: Date.now() - 1,
		};
		const { ctx } = makeContext(account);
		noSpace();
		const fetchMock = mockTokenEndpoint();

		await expect(
			getValidAccessToken(account, ctx as never),
		).rejects.toBeInstanceOf(RefreshStorageUnavailableError);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("says so once for a token, not once for every request", async () => {
		const warn = spyOn(Logger.prototype, "warn").mockImplementation(() => {});
		try {
			const account = stillValid("refused-quiet");
			const { ctx } = makeContext(account);
			noSpace();
			mockTokenEndpoint();

			for (let request = 0; request < 3; request += 1) {
				await expect(
					getValidAccessToken({ ...account }, ctx as never),
				).resolves.toBe("at-old");
			}

			const said = warn.mock.calls.filter(
				([message]) =>
					String(message).includes("refused-quiet") &&
					String(message).includes("disk space"),
			);
			expect(said).toHaveLength(1);
		} finally {
			warn.mockRestore();
		}
	});
});

describe("reserving slots at start", () => {
	const noAccess = (id: string, provider: string): Account => ({
		...makeAccount(id, provider),
		refresh_token: null,
	});

	it("asks for a slot for every account that rotates and for no other", async () => {
		const store = useStore(async () => {});
		const accounts: Account[] = [
			makeAccount("codex-a", "codex"),
			{ ...makeAccount("key-a", "openai-compatible"), api_key: "sk-test" },
			makeAccount("anthropic-a", "anthropic"),
			makeAccount("qwen-a", "qwen"),
			noAccess("codex-signed-out", "codex"),
			makeAccount("xai-a", "xai"),
		];

		await expect(
			reservePendingRotationSlots(async () => accounts),
		).resolves.toEqual({ reserved: 3, storageFull: 0, failed: 0 });
		expect(store.reserve.mock.calls.map(([accountId]) => accountId)).toEqual([
			"codex-a",
			"anthropic-a",
			"xai-a",
		]);
	});

	it("carries on past an account whose slot cannot be made", async () => {
		const store = useStore(async (accountId) => {
			if (accountId === "codex-full") throw storageFull();
			if (accountId === "codex-denied") {
				throw Object.assign(new Error("EACCES: permission denied, open"), {
					code: "EACCES",
				});
			}
		});

		await expect(
			reservePendingRotationSlots(async () => [
				makeAccount("codex-full", "codex"),
				makeAccount("codex-denied", "codex"),
				makeAccount("codex-fine", "codex"),
			]),
		).resolves.toEqual({ reserved: 1, storageFull: 1, failed: 1 });
		expect(store.reserve).toHaveBeenCalledTimes(3);
	});

	it("does not stop a start when the accounts cannot be read", async () => {
		const store = useStore(async () => {});

		await expect(
			reservePendingRotationSlots(async () => {
				throw Object.assign(new Error("database or disk is full"), {
					code: "SQLITE_FULL",
				});
			}),
		).resolves.toEqual({ reserved: 0, storageFull: 0, failed: 0 });
		expect(store.reserve).not.toHaveBeenCalled();
	});

	it("reserves nothing with a store that has no slots", async () => {
		configurePendingRotationPersistence({
			save: mock(async () => {}),
			load: mock(async () => []),
			remove: mock(async () => {}),
		});

		await expect(
			reservePendingRotationSlots(async () => [
				makeAccount("codex-a", "codex"),
				makeAccount("codex-b", "codex"),
			]),
		).resolves.toEqual({ reserved: 0, storageFull: 0, failed: 0 });
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

	it("restores the readable rotations at start when one account's slot cannot be read", async () => {
		// A damaged slot must cost that one account's rotation at most. It must
		// not stop the start, and it must not hide another account's rotation.
		const first = openStore();
		await first.save("slot-readable", {
			accessToken: "kept-access",
			expiresAt: Date.now() + 3_600_000,
			refreshToken: "kept-refresh",
			attemptedRefreshToken: "rt-old",
			createdAt: CREATED_AT,
			recordedAt: Date.now(),
		});
		const before = new Set(slotFiles());
		await first.reserve("slot-damaged");
		const damaged = slotFiles().filter((name) => !before.has(name));
		expect(damaged).toHaveLength(1);
		writeFileSync(join(directory, damaged[0] as string), randomBytes(65_536));

		const errors: string[] = [];
		configurePendingRotationPersistence(
			createPendingRotationStore({
				directory,
				secret: "round-trip-secret",
				log: {
					info: () => {},
					warn: () => {},
					error: (message) => {
						errors.push(message);
					},
				},
			}),
		);

		await expect(restorePendingRotations(async () => null)).resolves.toBe(1);
		expect(getPendingRotation("slot-readable", CREATED_AT)).toMatchObject({
			accessToken: "kept-access",
			refreshToken: "kept-refresh",
		});
		expect(getPendingRotation("slot-damaged", CREATED_AT)).toBeUndefined();
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain(damaged[0] as string);
	});

	const ISSUED_AT = 1_700_000_000_000;
	/**
	 * The durable row. Each request reads the account from it, so a request
	 * made while no write reaches the row starts from the same values again.
	 */
	const storedRow = (id: string): Account => ({
		...makeAccount(id, "codex"),
		refresh_token_issued_at: ISSUED_AT,
	});
	const databaseFull = (): Error =>
		Object.assign(new Error("database or disk is full"), {
			code: "SQLITE_FULL",
		});
	/**
	 * A token endpoint that rotates on every call. Returns the refresh tokens
	 * it was sent. The first access token is due for refresh as soon as it is
	 * issued, so the next request refreshes again.
	 */
	const rotatingEndpoint = (): string[] => {
		const sent: string[] = [];
		global.fetch = mock(async (_url: unknown, init?: RequestInit) => {
			sent.push(
				new URLSearchParams(String(init?.body)).get("refresh_token") ?? "",
			);
			const call = sent.length;
			return new Response(
				JSON.stringify({
					access_token: `access-${call}`,
					refresh_token: `refresh-${call}`,
					expires_in: call === 1 ? 60 : 3600,
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;
		return sent;
	};

	it("holds the later of two rotations when the database stays unwritable between them", async () => {
		// A full disk can outlast an access token. The second refresh must spend
		// the first rotation's refresh token, not the one the row still has, and
		// the slot must then hold the second rotation, still keyed on the row's.
		configurePendingRotationPersistence(openStore());
		const row = storedRow("two-rotations");
		const failing = makeContext(row);
		failing.dbOps.updateAccountTokensIfRefreshTokenMatches.mockImplementation(
			async () => {
				throw databaseFull();
			},
		);
		const sentRefreshTokens = rotatingEndpoint();

		await expect(
			getValidAccessToken({ ...row }, failing.ctx as never),
		).resolves.toBe("access-1");
		await expect(
			getValidAccessToken({ ...row }, failing.ctx as never),
		).resolves.toBe("access-2");
		expect(sentRefreshTokens).toEqual(["rt-old", "refresh-1"]);
		expect(slotFiles()).toHaveLength(1);

		// The next process, with the database writable again.
		clearAllPendingRotationsForTests();
		configurePendingRotationPersistence(openStore());
		const stored = storedRow("two-rotations");
		const working = makeContext(stored);
		await expect(
			restorePendingRotations(async (accountId) =>
				working.dbOps.getAccount(accountId),
			),
		).resolves.toBe(1);
		expect(getPendingRotation("two-rotations", CREATED_AT)).toMatchObject({
			accessToken: "access-2",
			refreshToken: "refresh-2",
			attemptedRefreshToken: "rt-old",
		});

		const thirdCall = mock(async () => {
			throw new Error("the provider must not be asked again");
		});
		global.fetch = thirdCall as unknown as typeof fetch;
		await expect(
			getValidAccessToken(stored, working.ctx as never),
		).resolves.toBe("access-2");
		expect(thirdCall).not.toHaveBeenCalled();
		const written = working.dbOps.updateAccountTokensIfRefreshTokenMatches.mock
			.calls[0] as unknown[];
		expect(written[1]).toBe("rt-old");
		expect(written[2]).toBe("access-2");
		expect(written[4]).toBe("refresh-2");
		expect(stored.refresh_token).toBe("refresh-2");
	});

	it("writes the later rotation to the row when the database takes writes again before it is stored", async () => {
		// Some writes get through on a full disk. The row was never told about
		// the first rotation, so it holds the token that rotation spent, not the
		// one the second refresh has just spent. The second rotation is the only
		// one the provider still honours and must reach the row.
		configurePendingRotationPersistence(openStore());
		const row = storedRow("late-write");
		const db = makeContext(row);
		const rowRefreshTokens: string[] = [];
		let writes = 0;
		db.dbOps.updateAccountTokensIfRefreshTokenMatches.mockImplementation(
			async (...args: unknown[]) => {
				writes += 1;
				if (writes <= 2) throw databaseFull();
				const [, expected, accessToken, expiresAt, refreshToken] = args as [
					string,
					string,
					string,
					number,
					string | undefined,
				];
				if (db.row().refresh_token !== expected) return false;
				db.store({
					access_token: accessToken,
					expires_at: expiresAt,
					...(refreshToken ? { refresh_token: refreshToken } : {}),
				});
				if (refreshToken) rowRefreshTokens.push(refreshToken);
				return true;
			},
		);
		const sentRefreshTokens = rotatingEndpoint();

		await expect(
			getValidAccessToken({ ...row }, db.ctx as never),
		).resolves.toBe("access-1");
		const second = { ...row };
		await expect(getValidAccessToken(second, db.ctx as never)).resolves.toBe(
			"access-2",
		);

		expect(sentRefreshTokens).toEqual(["rt-old", "refresh-1"]);
		expect(db.row()).toMatchObject({
			access_token: "access-2",
			refresh_token: "refresh-2",
		});
		// The spent first rotation never reached the row.
		expect(rowRefreshTokens).toEqual(["refresh-2"]);
		expect(second.refresh_token).toBe("refresh-2");

		// Nothing is left waiting: the removal from the slot is queued by the
		// refresh, not awaited, so let it run.
		expect(getPendingRotation("late-write", CREATED_AT)).toBeUndefined();
		await new Promise((resolve) => setTimeout(resolve, 0));
		clearAllPendingRotationsForTests();
		configurePendingRotationPersistence(openStore());
		await expect(restorePendingRotations()).resolves.toBe(0);
	});

	for (const landing of ["before", "after"] as const) {
		it(`writes the later rotation to the row when the first rotation is stored just ${landing} its first write`, async () => {
			// A request that started before this refresh can still be storing
			// the first rotation. Whichever side of the first write it lands on,
			// the row must end with the second rotation and never go back to
			// the first, whose refresh token is spent.
			configurePendingRotationPersistence(openStore());
			const row = storedRow(`store-lands-${landing}`);
			const db = makeContext(row);
			const sentRefreshTokens = rotatingEndpoint();
			const storeFirstRotation = () => {
				if (db.row().refresh_token !== "rt-old") return;
				db.store({ access_token: "access-1", refresh_token: "refresh-1" });
			};
			let storeHasLanded = false;
			db.dbOps.updateAccountTokensIfRefreshTokenMatches.mockImplementation(
				async (...args: unknown[]) => {
					// Nothing reaches the row until the second rotation exists.
					if (sentRefreshTokens.length < 2) throw databaseFull();
					const [, expected, accessToken, expiresAt, refreshToken] = args as [
						string,
						string,
						string,
						number,
						string | undefined,
					];
					const landNow = !storeHasLanded;
					storeHasLanded = true;
					if (landNow && landing === "before") storeFirstRotation();
					const matched = db.row().refresh_token === expected;
					if (matched) {
						db.store({
							access_token: accessToken,
							expires_at: expiresAt,
							...(refreshToken ? { refresh_token: refreshToken } : {}),
						});
					}
					if (landNow && landing === "after") storeFirstRotation();
					return matched;
				},
			);

			await expect(
				getValidAccessToken({ ...row }, db.ctx as never),
			).resolves.toBe("access-1");
			const second = { ...row };
			await expect(getValidAccessToken(second, db.ctx as never)).resolves.toBe(
				"access-2",
			);

			expect(sentRefreshTokens).toEqual(["rt-old", "refresh-1"]);
			expect(db.row()).toMatchObject({
				access_token: "access-2",
				refresh_token: "refresh-2",
			});
			expect(second.refresh_token).toBe("refresh-2");
		});
	}

	it("does not take the row's spent refresh token back along with a longer-lived stored access token", async () => {
		// A 401 can force a refresh while the stored access token has not
		// expired. The row's access token then outlives the rotated one, and
		// the row is adopted for it. Its refresh token is the one the unstored
		// rotation spent and must be left where it is.
		configurePendingRotationPersistence(openStore());
		const row: Account = {
			...storedRow("longer-lived-row"),
			access_token: "at-row",
			expires_at: Date.now() + 2 * 60 * 60 * 1000,
		};
		const failing = makeContext(row);
		failing.dbOps.updateAccountTokensIfRefreshTokenMatches.mockImplementation(
			async () => {
				throw databaseFull();
			},
		);
		const sentRefreshTokens = rotatingEndpoint();

		await expect(
			refreshAccessTokenSafe({ ...row }, failing.ctx as never),
		).resolves.toBe("access-1");
		const second = { ...row };
		await expect(
			refreshAccessTokenSafe(second, failing.ctx as never),
		).resolves.toBe("at-row");

		expect(sentRefreshTokens).toEqual(["rt-old"]);
		expect(second.refresh_token).toBe("refresh-1");
	});

	it("does not send the spent refresh token again when the slot cannot be written either", async () => {
		// The database write fails and so does the slot: a failing device, or a
		// filesystem that allocates on overwrite. The refresh path handles this
		// as it did before slots existed: the refresh fails and starts its
		// backoff, and the rotation is held in memory only. What must not
		// happen is the spent refresh token going back to the provider, which
		// would answer invalid_grant and get a healthy account flagged.
		const store = openStore();
		configurePendingRotationPersistence({
			...store,
			save: async () => {
				throw Object.assign(new Error("EIO: i/o error, write"), {
					code: "EIO",
				});
			},
		});
		const row = storedRow("slot-unwritable");
		const failing = makeContext(row);
		failing.dbOps.updateAccountTokensIfRefreshTokenMatches.mockImplementation(
			async () => {
				throw databaseFull();
			},
		);
		const sentRefreshTokens: string[] = [];
		global.fetch = mock(async (_url: unknown, init?: RequestInit) => {
			sentRefreshTokens.push(
				new URLSearchParams(String(init?.body)).get("refresh_token") ?? "",
			);
			const call = sentRefreshTokens.length;
			return new Response(
				JSON.stringify({
					access_token: `access-${call}`,
					refresh_token: `refresh-${call}`,
					expires_in: 3600,
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		await expect(
			getValidAccessToken({ ...row }, failing.ctx as never),
		).rejects.toThrow();
		expect(sentRefreshTokens).toEqual(["rt-old"]);

		// Inside the backoff nothing is sent at all.
		await expect(
			getValidAccessToken({ ...row }, failing.ctx as never),
		).rejects.toThrow("backoff period");
		expect(sentRefreshTokens).toEqual(["rt-old"]);

		// After it, the rotation held in memory is served, and its refresh
		// token is the one the account carries from then on.
		setSystemTime(Date.now() + TOKEN_REFRESH_BACKOFF_MS + 1_000);
		try {
			const later = { ...row };
			await expect(
				getValidAccessToken(later, failing.ctx as never),
			).resolves.toBe("access-1");
			expect(later.refresh_token).toBe("refresh-1");
		} finally {
			setSystemTime();
		}
		expect(sentRefreshTokens).toEqual(["rt-old"]);
		expect(
			failing.dbOps.flagRequiresReauthIfTokenMatches,
		).not.toHaveBeenCalled();
		expect(failing.dbOps.pauseAccountIfActive).not.toHaveBeenCalled();
	});
});
