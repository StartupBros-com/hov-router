import { Database } from "bun:sqlite";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import { EventEmitter } from "node:events";
import type { Config } from "@better-ccflare/config";
import { orgPermissionDeniedEvents, requestEvents } from "@better-ccflare/core";
import {
	BunSqlAdapter,
	ensureSchema,
	runMigrations,
} from "@better-ccflare/database";
import type { AlertEvent, RequestResponse } from "@better-ccflare/types";
import { AlertService, buildDiscordAlertContent } from "../alerts";

// Issue #877: on 2026-11-16 Anthropic refused max-primary-bros for over two
// hours after a failed payment, drawing a fresh 403 about every two minutes,
// and nothing told the operator. These pin one ping when a refusal starts,
// silence while it continues, and one ping when the account serves again.

const ACCOUNT = {
	accountId: "acc-refused",
	accountName: "max-primary",
	provider: "anthropic",
};

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) return;
		await Bun.sleep(5);
	}
	throw new Error("Timed out waiting for org refusal alert processing");
}

function makeConfig(): Config {
	const store = new Map<string, string | number | boolean>();
	return Object.assign(new EventEmitter(), {
		getAlertDailySpendUsd: () => 0,
		getAlertTokensPerHour: () => 0,
		getAlertRequestTokens: () => 0,
		getAlertUsageWindowThresholdPercent: () => 0,
		getAlertCacheHealthEnabled: () => false,
		getAlertCacheHealthThresholdPercent: () => 80,
		getAlertCacheHealthDurationMinutes: () => 15,
		getAlertCacheHealthMinRequests: () => 5,
		getAlertCacheHealthMinInputTokens: () => 10000,
		getAlertCacheHealthReminderMinutes: () => 60,
		getMemberNoticeWebhookUrl: () => "",
		getMemberNoticeSigningSecret: () => "",
		getAlertCooldownMinutes: () => 60,
		getAlertWebhookUrl: () => "http://127.0.0.1:9999/webhook",
		getAlertWebhookTypes: () => [],
		get: (
			key: string,
			defaultValue?: string | number | boolean,
		): string | number | boolean | undefined => {
			if (store.has(key)) return store.get(key);
			if (defaultValue !== undefined) {
				store.set(key, defaultValue);
				return defaultValue;
			}
			return undefined;
		},
		set: (key: string, value: string | number | boolean): void => {
			store.set(key, value);
		},
	}) as unknown as Config;
}

function refuse(at: number, accountId = ACCOUNT.accountId): void {
	orgPermissionDeniedEvents.emit("event", {
		...ACCOUNT,
		accountId,
		timestamp: at,
	});
}

function served(
	startedAt: number,
	overrides: Partial<RequestResponse> = {},
): void {
	const payload = {
		id: `req-${startedAt}`,
		timestamp: new Date(startedAt).toISOString(),
		method: "POST",
		path: "/v1/messages",
		accountUsed: ACCOUNT.accountId,
		statusCode: 200,
		success: true,
		errorMessage: null,
		responseTimeMs: 10,
		failoverAttempts: 0,
		...overrides,
	} as RequestResponse;
	requestEvents.emit("event", { type: "summary", payload });
}

/** One usage check's verdict on the organization (#941), as the usage
 * cache reports it. */
function usageCheck(
	outcome: "refused" | "accepted",
	startedAt: number,
	accountId = ACCOUNT.accountId,
): void {
	orgPermissionDeniedEvents.emit("usage", {
		accountId,
		outcome,
		startedAt,
		answeredAt: startedAt + 1_000,
	});
}

describe("AlertService org_permission_denied episodes", () => {
	let sqlite: Database;
	let adapter: BunSqlAdapter;
	let service: AlertService;
	let originalFetch: typeof globalThis.fetch;
	let fetchMock: ReturnType<typeof mock>;

	/** Make the next insert of an org_permission_denied alert throw, as a
	 * locked database would; every other write goes through. */
	const failNextOrgAlertWrite = () => {
		const real = adapter.runWithChanges.bind(adapter);
		let armed = true;
		spyOn(adapter, "runWithChanges").mockImplementation(
			async (sqlStr: string, params: unknown[] = []) => {
				const id = params[0];
				if (
					armed &&
					typeof id === "string" &&
					id.startsWith("org_permission_denied:")
				) {
					armed = false;
					throw new Error("database is locked");
				}
				return real(sqlStr, params);
			},
		);
	};
	// Ten minutes ago, so every refusal and request below stays in one
	// cooldown hour unless the test means otherwise.
	let t0: number;

	const ofPhase = (alerts: AlertEvent[], phase: string) =>
		alerts.filter((alert) => alert.id.split(":")[1] === phase);

	beforeEach(() => {
		sqlite = new Database(":memory:");
		ensureSchema(sqlite);
		// The accounts table gains `paused` in a migration, as in production.
		runMigrations(sqlite);
		adapter = new BunSqlAdapter(sqlite);
		service = new AlertService(adapter, makeConfig());
		originalFetch = globalThis.fetch;
		fetchMock = mock(async () => new Response(null, { status: 204 }));
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		t0 = Date.now() - 10 * 60_000;
		service.start();
	});

	afterEach(async () => {
		await service.stop();
		globalThis.fetch = originalFetch;
		sqlite.close();
	});

	it("pings once when a refusal starts, not on every refused request", async () => {
		refuse(t0);
		await waitFor(() => fetchMock.mock.calls.length === 1);
		refuse(t0 + 120_000);
		refuse(t0 + 240_000);
		await Bun.sleep(30);

		const alerts = await service.listAlerts();
		expect(alerts).toHaveLength(1);
		expect(alerts[0]?.type).toBe("org_permission_denied");
		expect(alerts[0]?.severity).toBe("critical");
		expect(alerts[0]?.account).toBe("max-primary");
		expect(alerts[0]?.message).toContain("billing");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(JSON.parse(String(init.body)).alert.type).toBe(
			"org_permission_denied",
		);
	});

	it("pings recovered on the first success that started after the latest refusal", async () => {
		refuse(t0);
		refuse(t0 + 120_000);
		await waitFor(() => fetchMock.mock.calls.length === 1);

		served(t0 + 180_000);
		await waitFor(() => fetchMock.mock.calls.length === 2);
		served(t0 + 240_000);
		await Bun.sleep(30);

		const alerts = await service.listAlerts();
		expect(alerts).toHaveLength(2);
		const [recovered] = ofPhase(alerts, "recovered");
		expect(recovered?.type).toBe("org_permission_denied");
		expect(recovered?.severity).toBe("info");
		expect(recovered?.account).toBe("max-primary");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("ignores a success from a request that started before the latest refusal", async () => {
		// A long stream that began before Anthropic started refusing can end
		// with a 200 afterwards; it proves nothing about the organization now.
		refuse(t0);
		refuse(t0 + 120_000);
		await waitFor(() => fetchMock.mock.calls.length === 1);

		served(t0 + 60_000);
		await Bun.sleep(30);

		expect(ofPhase(await service.listAlerts(), "recovered")).toHaveLength(0);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("ignores failed requests and other accounts' successes", async () => {
		refuse(t0);
		await waitFor(() => fetchMock.mock.calls.length === 1);

		served(t0 + 60_000, { success: false, statusCode: 403 });
		served(t0 + 60_000, { accountUsed: "acc-healthy" });
		await Bun.sleep(30);

		expect(ofPhase(await service.listAlerts(), "recovered")).toHaveLength(0);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("pings again for a new refusal after a recovery inside the same hour", async () => {
		refuse(t0);
		await waitFor(() => fetchMock.mock.calls.length === 1);
		served(t0 + 60_000);
		await waitFor(() => fetchMock.mock.calls.length === 2);
		refuse(t0 + 120_000);
		await waitFor(() => fetchMock.mock.calls.length === 3);

		const alerts = await service.listAlerts();
		expect(ofPhase(alerts, "refused")).toHaveLength(2);
		expect(ofPhase(alerts, "recovered")).toHaveLength(1);
	});

	it("alerts on the next refusal when the first alert could not be saved", async () => {
		failNextOrgAlertWrite();
		refuse(t0);
		await Bun.sleep(30);
		expect(await service.listAlerts()).toHaveLength(0);

		refuse(t0 + 120_000);
		await waitFor(() => fetchMock.mock.calls.length === 1);
		expect(ofPhase(await service.listAlerts(), "refused")).toHaveLength(1);
	});

	it("alerts recovery on the next success when the recovered alert could not be saved", async () => {
		refuse(t0);
		await waitFor(() => fetchMock.mock.calls.length === 1);

		failNextOrgAlertWrite();
		served(t0 + 60_000);
		await Bun.sleep(30);
		expect(ofPhase(await service.listAlerts(), "recovered")).toHaveLength(0);

		served(t0 + 120_000);
		await waitFor(() => fetchMock.mock.calls.length === 2);
		expect(ofPhase(await service.listAlerts(), "recovered")).toHaveLength(1);
	});

	it("tracks each account's refusal separately", async () => {
		refuse(t0);
		refuse(t0, "acc-other");
		await waitFor(() => fetchMock.mock.calls.length === 2);

		served(t0 + 60_000);
		await waitFor(() => fetchMock.mock.calls.length === 3);

		const recovered = ofPhase(await service.listAlerts(), "recovered");
		expect(recovered).toHaveLength(1);
		expect(recovered[0]?.id).toContain(ACCOUNT.accountId);
	});

	it("words the webhook message for a refusal and for a recovery", async () => {
		refuse(t0);
		await waitFor(() => fetchMock.mock.calls.length === 1);
		served(t0 + 60_000);
		await waitFor(() => fetchMock.mock.calls.length === 2);

		const alerts = await service.listAlerts();
		const refused = buildDiscordAlertContent(
			ofPhase(alerts, "refused")[0] as AlertEvent,
		);
		expect(refused).toStartWith(
			"**CRITICAL: Anthropic is refusing this account's organization.**",
		);
		expect(refused).toContain("Affected: account max-primary.");
		expect(refused).toContain("claude.ai");

		const recovered = buildDiscordAlertContent(
			ofPhase(alerts, "recovered")[0] as AlertEvent,
		);
		expect(recovered).toStartWith(
			"**INFO: Anthropic accepts this account's organization again.**",
		);
	});

	describe("usage checks (#941)", () => {
		const addAccount = (id: string, name: string, paused = 0) =>
			sqlite.run(
				"INSERT INTO accounts (id, name, created_at, paused) VALUES (?, ?, ?, ?)",
				[id, name, Date.now(), paused],
			);

		beforeEach(() => {
			addAccount(ACCOUNT.accountId, ACCOUNT.accountName);
		});

		it("pings when a usage check is refused and no request was", async () => {
			// An account nobody routes to is still polled; its refusal must not
			// wait for a request to be noticed.
			usageCheck("refused", t0);
			await waitFor(() => fetchMock.mock.calls.length === 1);
			usageCheck("refused", t0 + 30 * 60_000);
			await Bun.sleep(30);

			const alerts = await service.listAlerts();
			expect(alerts).toHaveLength(1);
			expect(alerts[0]?.severity).toBe("critical");
			expect(alerts[0]?.account).toBe("max-primary");
			expect(alerts[0]?.message).toContain("usage check");
			expect(alerts[0]?.message).toContain("billing");
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		it("pings recovered on an accepted usage check, with no traffic, once the usage check was refused too", async () => {
			// 2026-11-21: one refused request opened the episode, the usage check
			// was refused every 30 min, and nothing closed it until traffic.
			refuse(t0);
			usageCheck("refused", t0 + 20_000);
			await waitFor(() => fetchMock.mock.calls.length === 1);
			await Bun.sleep(30);
			expect(fetchMock).toHaveBeenCalledTimes(1);

			usageCheck("accepted", t0 + 5 * 60_000);
			await waitFor(() => fetchMock.mock.calls.length === 2);
			usageCheck("accepted", t0 + 6 * 60_000);
			await Bun.sleep(30);

			const [recovered, ...more] = ofPhase(
				await service.listAlerts(),
				"recovered",
			);
			expect(more).toHaveLength(0);
			expect(recovered?.severity).toBe("info");
			expect(recovered?.account).toBe("max-primary");
			expect(recovered?.message).toContain("usage check");
			expect(recovered?.message).toContain("5 min");
			expect(recovered?.requestId).toBeNull();
			expect(fetchMock).toHaveBeenCalledTimes(2);
		});

		it("does not let an accepted usage check close an episode only requests were refused in", async () => {
			// The usage endpoint answering says nothing about /v1/messages unless
			// it refused too; Claude Code access can be off while usage works.
			refuse(t0);
			await waitFor(() => fetchMock.mock.calls.length === 1);

			usageCheck("accepted", t0 + 60_000);
			await Bun.sleep(30);
			expect(ofPhase(await service.listAlerts(), "recovered")).toHaveLength(0);

			served(t0 + 120_000);
			await waitFor(() => fetchMock.mock.calls.length === 2);
		});

		it("ignores an accepted usage check that started before the latest refusal", async () => {
			usageCheck("refused", t0);
			await waitFor(() => fetchMock.mock.calls.length === 1);
			refuse(t0 + 120_000);

			usageCheck("accepted", t0 + 60_000);
			await Bun.sleep(30);
			expect(ofPhase(await service.listAlerts(), "recovered")).toHaveLength(0);

			usageCheck("accepted", t0 + 180_000);
			await waitFor(() => fetchMock.mock.calls.length === 2);
		});

		it("closes a usage-opened episode when the account serves a request", async () => {
			usageCheck("refused", t0);
			await waitFor(() => fetchMock.mock.calls.length === 1);

			served(t0 + 60_000);
			await waitFor(() => fetchMock.mock.calls.length === 2);
			const [recovered] = ofPhase(await service.listAlerts(), "recovered");
			expect(recovered?.message).toContain("served a request");
		});

		it("opens one episode when a usage refusal and a request refusal arrive together", async () => {
			usageCheck("refused", t0);
			refuse(t0 + 500);
			await waitFor(() => fetchMock.mock.calls.length === 1);
			await Bun.sleep(30);

			expect(ofPhase(await service.listAlerts(), "refused")).toHaveLength(1);
			expect(fetchMock).toHaveBeenCalledTimes(1);

			// The usage refusal still counts in that episode, so an accepted
			// usage check can close it.
			usageCheck("accepted", t0 + 60_000);
			await waitFor(() => fetchMock.mock.calls.length === 2);
		});

		it("stays quiet for a paused account and for one it cannot find", async () => {
			addAccount("acc-paused", "max-paused", 1);
			usageCheck("refused", t0, "acc-paused");
			usageCheck("refused", t0, "acc-removed");
			await Bun.sleep(50);

			expect(await service.listAlerts()).toHaveLength(0);
			expect(fetchMock).toHaveBeenCalledTimes(0);
		});

		it("counts a paused account's usage refusal in an episode a request refusal opened during the lookup", async () => {
			addAccount("acc-paused", "max-paused", 1);
			usageCheck("refused", t0, "acc-paused");
			refuse(t0 + 500, "acc-paused");
			await waitFor(() => fetchMock.mock.calls.length === 1);

			usageCheck("accepted", t0 + 60_000, "acc-paused");
			await waitFor(() => fetchMock.mock.calls.length === 2);
			expect(ofPhase(await service.listAlerts(), "recovered")).toHaveLength(1);
		});

		it("alerts on the next refused usage check when the first alert could not be saved", async () => {
			failNextOrgAlertWrite();
			usageCheck("refused", t0);
			await Bun.sleep(30);
			expect(await service.listAlerts()).toHaveLength(0);

			usageCheck("refused", t0 + 30 * 60_000);
			await waitFor(() => fetchMock.mock.calls.length === 1);
			expect(ofPhase(await service.listAlerts(), "refused")).toHaveLength(1);
		});
	});
});
