/**
 * Data-layer tests for the stored extra-usage holds: the hold a billed
 * response starts, the holds a usage reading writes, and the switch change.
 *
 * Runs on the real SQLite schema (ensureSchema + runMigrations) so each guard
 * is exercised by the statement itself, not by the caller.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
// Initialise @better-ccflare/core before types (circular import ordering).
import "@better-ccflare/core";
import type { ExtraUsageHoldState } from "@better-ccflare/types";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "../../migrations";
import { AccountRepository } from "../account.repository";

const CREATED_AT = 1_700_000_000_000;
const T0 = 1_800_000_000_000;

interface Seed {
	id?: string;
	switchOn?: boolean;
	paused?: boolean;
	pauseReason?: string | null;
	billedAt?: number | null;
	billedFamily?: string | null;
	holds?: ExtraUsageHoldState | null;
}

function seed(db: Database, s: Seed = {}): string {
	const id = s.id ?? "a1";
	db.run(
		`INSERT INTO accounts (id, name, provider, created_at, auto_pause_on_overage_enabled,
			paused, pause_reason, overage_billed_at, overage_billed_family, extra_usage_holds)
		 VALUES (?, ?, 'anthropic', ?, ?, ?, ?, ?, ?, ?)`,
		[
			id,
			id,
			CREATED_AT,
			s.switchOn === false ? 0 : 1,
			s.paused ? 1 : 0,
			s.pauseReason ?? null,
			s.billedAt ?? null,
			s.billedFamily ?? null,
			s.holds ? JSON.stringify(s.holds) : null,
		],
	);
	return id;
}

function opusHold(readingAt: number, resetsAtMs: number): ExtraUsageHoldState {
	return {
		readingAt,
		holds: [
			{
				windowKey: "seven_day_opus",
				scope: "family",
				modelFamily: "opus",
				resetsAtMs,
				startedAt: readingAt,
			},
		],
	};
}

describe("stored extra-usage holds", () => {
	let db: Database;
	let repo: AccountRepository;

	beforeEach(() => {
		db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);
		repo = new AccountRepository(new BunSqlAdapter(db));
	});

	afterEach(() => {
		db.close();
	});

	describe("reading the columns", () => {
		it("maps empty columns to null on findById and findAll", async () => {
			seed(db);
			const one = await repo.findById("a1");
			expect(one?.extra_usage_holds).toBeNull();
			expect(one?.overage_billed_at).toBeNull();
			expect(one?.overage_billed_family).toBeNull();
			const [all] = await repo.findAll();
			expect(all?.extra_usage_holds).toBeNull();
			expect(all?.overage_billed_at).toBeNull();
			expect(all?.overage_billed_family).toBeNull();
		});

		it("parses stored holds and billed columns", async () => {
			const state = opusHold(T0, T0 + 3_600_000);
			seed(db, {
				holds: state,
				paused: true,
				pauseReason: "overage",
				billedAt: T0 - 5,
				billedFamily: "opus",
			});
			const acct = await repo.findById("a1");
			expect(acct?.extra_usage_holds).toEqual(state);
			expect(acct?.overage_billed_at).toBe(T0 - 5);
			expect(acct?.overage_billed_family).toBe("opus");
		});

		it("reads a malformed holds value as no holds", async () => {
			seed(db);
			db.run(
				`UPDATE accounts SET extra_usage_holds = 'not json' WHERE id = 'a1'`,
			);
			expect((await repo.findById("a1"))?.extra_usage_holds).toBeNull();
		});
	});

	describe("hold from a billed response", () => {
		it("pauses an active login with the billed time and family", async () => {
			seed(db);
			expect(await repo.holdForBilledResponse("a1", T0, "opus")).toBe(true);
			const acct = await repo.findById("a1");
			expect(acct?.paused).toBe(true);
			expect(acct?.pause_reason).toBe("overage");
			expect(acct?.overage_billed_at).toBe(T0);
			expect(acct?.overage_billed_family).toBe("opus");
		});

		it("writes nothing while the switch is off", async () => {
			seed(db, { switchOn: false });
			expect(await repo.holdForBilledResponse("a1", T0, "opus")).toBe(false);
			const acct = await repo.findById("a1");
			expect(acct?.paused).toBe(false);
			expect(acct?.pause_reason).toBeNull();
			expect(acct?.overage_billed_at).toBeNull();
		});

		it("leaves a manual pause and its reason alone", async () => {
			seed(db, { paused: true, pauseReason: "manual" });
			expect(await repo.holdForBilledResponse("a1", T0, "opus")).toBe(false);
			const acct = await repo.findById("a1");
			expect(acct?.pause_reason).toBe("manual");
			expect(acct?.overage_billed_at).toBeNull();
			expect(acct?.overage_billed_family).toBeNull();
		});

		it("moves the billed time to the later response and keeps a matching family", async () => {
			seed(db);
			await repo.holdForBilledResponse("a1", T0, "opus");
			expect(await repo.holdForBilledResponse("a1", T0 + 10, "opus")).toBe(
				true,
			);
			const acct = await repo.findById("a1");
			expect(acct?.overage_billed_at).toBe(T0 + 10);
			expect(acct?.overage_billed_family).toBe("opus");
		});

		it("clears the family when a second billed response is another family", async () => {
			seed(db);
			await repo.holdForBilledResponse("a1", T0, "opus");
			await repo.holdForBilledResponse("a1", T0 + 10, "sonnet");
			const acct = await repo.findById("a1");
			expect(acct?.overage_billed_at).toBe(T0 + 10);
			expect(acct?.overage_billed_family).toBeNull();
			expect(acct?.pause_reason).toBe("overage");
		});

		it("keeps the later billed time when an earlier response is recorded second", async () => {
			seed(db);
			await repo.holdForBilledResponse("a1", T0 + 10, "opus");
			await repo.holdForBilledResponse("a1", T0, "opus");
			expect((await repo.findById("a1"))?.overage_billed_at).toBe(T0 + 10);
		});

		// A pause from before the upgrade recorded no billed model, so no reading
		// may ever end it; a further billed response must not give it one.
		it("keeps a pre-upgrade pause without a billed time or family", async () => {
			seed(db, { paused: true, pauseReason: "overage" });
			expect(await repo.holdForBilledResponse("a1", T0, "opus")).toBe(true);
			const acct = await repo.findById("a1");
			expect(acct?.pause_reason).toBe("overage");
			expect(acct?.overage_billed_at).toBeNull();
			expect(acct?.overage_billed_family).toBeNull();
		});

		it("keeps the holds from a reading when a billed response pauses the login", async () => {
			const state = opusHold(T0 - 60_000, T0 + 3_600_000);
			seed(db, { holds: state });
			expect(await repo.holdForBilledResponse("a1", T0, "sonnet")).toBe(true);
			const acct = await repo.findById("a1");
			expect(acct?.paused).toBe(true);
			expect(acct?.pause_reason).toBe("overage");
			expect(acct?.overage_billed_family).toBe("sonnet");
			expect(acct?.extra_usage_holds).toEqual(state);
		});

		it("holds a resumed login again and overwrites the old billed columns", async () => {
			seed(db, { billedAt: T0 - 100, billedFamily: "sonnet" });
			expect(await repo.holdForBilledResponse("a1", T0, "opus")).toBe(true);
			const acct = await repo.findById("a1");
			expect(acct?.paused).toBe(true);
			expect(acct?.overage_billed_at).toBe(T0);
			expect(acct?.overage_billed_family).toBe("opus");
		});
	});

	describe("holds from a reading", () => {
		it("stores the holds and the reading time", async () => {
			seed(db);
			const state = opusHold(T0, T0 + 3_600_000);
			expect(await repo.writeExtraUsageHolds("a1", state)).toBe(true);
			expect((await repo.findById("a1"))?.extra_usage_holds).toEqual(state);
		});

		it("writes nothing for a stale account generation", async () => {
			seed(db);
			const state = opusHold(T0, T0 + 3_600_000);
			expect(
				await repo.writeExtraUsageHolds("a1", state, {
					expectedCreatedAt: CREATED_AT + 1,
				}),
			).toBe(false);
			expect((await repo.findById("a1"))?.extra_usage_holds).toBeNull();
			expect(
				await repo.writeExtraUsageHolds("a1", state, {
					expectedCreatedAt: CREATED_AT,
				}),
			).toBe(true);
		});

		it("never lets an older reading overwrite a newer one", async () => {
			const newer = opusHold(T0, T0 + 3_600_000);
			seed(db, { holds: newer });
			expect(
				await repo.writeExtraUsageHolds("a1", { readingAt: T0 - 1, holds: [] }),
			).toBe(false);
			expect((await repo.findById("a1"))?.extra_usage_holds).toEqual(newer);
			const later = { readingAt: T0 + 1, holds: [] };
			expect(await repo.writeExtraUsageHolds("a1", later)).toBe(true);
			expect((await repo.findById("a1"))?.extra_usage_holds).toEqual(later);
		});

		it("writes nothing while the switch is off", async () => {
			seed(db, { switchOn: false });
			expect(
				await repo.writeExtraUsageHolds("a1", opusHold(T0, T0 + 3_600_000)),
			).toBe(false);
			expect((await repo.findById("a1"))?.extra_usage_holds).toBeNull();
		});

		it("ends the billed pause in the same write when the billed time still matches", async () => {
			seed(db, {
				paused: true,
				pauseReason: "overage",
				billedAt: T0 - 50,
				billedFamily: "opus",
			});
			const state = opusHold(T0, T0 + 3_600_000);
			expect(
				await repo.writeExtraUsageHolds("a1", state, {
					narrowBilled: { billedAt: T0 - 50, family: "opus" },
				}),
			).toBe(true);
			const acct = await repo.findById("a1");
			expect(acct?.paused).toBe(false);
			expect(acct?.pause_reason).toBeNull();
			expect(acct?.extra_usage_holds).toEqual(state);
		});

		it("keeps the billed pause when a billed response in the same millisecond changed the family read", async () => {
			seed(db, {
				paused: true,
				pauseReason: "overage",
				billedAt: T0 - 50,
				billedFamily: "opus",
			});
			// The reading saw an Opus billed hold; a Sonnet response billed at the
			// same instant then marked the hold as mixed before the write.
			expect(await repo.holdForBilledResponse("a1", T0 - 50, "sonnet")).toBe(
				true,
			);
			const state = opusHold(T0, T0 + 3_600_000);
			expect(
				await repo.writeExtraUsageHolds("a1", state, {
					narrowBilled: { billedAt: T0 - 50, family: "opus" },
				}),
			).toBe(true);
			const acct = await repo.findById("a1");
			expect(acct?.paused).toBe(true);
			expect(acct?.pause_reason).toBe("overage");
			expect(acct?.overage_billed_family).toBeNull();
			expect(acct?.extra_usage_holds).toEqual(state);
		});

		it("ends a billed pause with no family when the reading saw no family", async () => {
			seed(db, {
				paused: true,
				pauseReason: "overage",
				billedAt: T0 - 50,
				billedFamily: null,
			});
			const state = opusHold(T0, T0 + 3_600_000);
			expect(
				await repo.writeExtraUsageHolds("a1", state, {
					narrowBilled: { billedAt: T0 - 50, family: null },
				}),
			).toBe(true);
			expect((await repo.findById("a1"))?.paused).toBe(false);
		});

		it("keeps the billed pause when a newer billed response replaced the time read", async () => {
			seed(db, {
				paused: true,
				pauseReason: "overage",
				billedAt: T0 - 10,
				billedFamily: "opus",
			});
			const state = opusHold(T0, T0 + 3_600_000);
			expect(
				await repo.writeExtraUsageHolds("a1", state, {
					narrowBilled: { billedAt: T0 - 50, family: "opus" },
				}),
			).toBe(true);
			const acct = await repo.findById("a1");
			expect(acct?.paused).toBe(true);
			expect(acct?.pause_reason).toBe("overage");
			expect(acct?.extra_usage_holds).toEqual(state);
		});
	});

	describe("switch change", () => {
		it("turning on from off stores the holds it is given", async () => {
			seed(db, { switchOn: false });
			const state = opusHold(T0, T0 + 3_600_000);
			expect(await repo.setAutoPauseOnOverageEnabled("a1", true, state)).toBe(
				true,
			);
			const acct = await repo.findById("a1");
			expect(acct?.auto_pause_on_overage_enabled).toBe(true);
			expect(acct?.extra_usage_holds).toEqual(state);
		});

		it("turning on leaves an existing overage pause in place", async () => {
			seed(db, { switchOn: false, paused: true, pauseReason: "overage" });
			expect(await repo.setAutoPauseOnOverageEnabled("a1", true, null)).toBe(
				true,
			);
			const acct = await repo.findById("a1");
			expect(acct?.paused).toBe(true);
			expect(acct?.pause_reason).toBe("overage");
			expect(acct?.extra_usage_holds).toBeNull();
		});

		it("turning off from on clears holds and billed columns and ends an overage pause", async () => {
			seed(db, {
				holds: opusHold(T0, T0 + 3_600_000),
				paused: true,
				pauseReason: "overage",
				billedAt: T0,
				billedFamily: "opus",
			});
			expect(await repo.setAutoPauseOnOverageEnabled("a1", false)).toBe(true);
			const acct = await repo.findById("a1");
			expect(acct?.auto_pause_on_overage_enabled).toBe(false);
			expect(acct?.extra_usage_holds).toBeNull();
			expect(acct?.overage_billed_at).toBeNull();
			expect(acct?.overage_billed_family).toBeNull();
			expect(acct?.paused).toBe(false);
			expect(acct?.pause_reason).toBeNull();
		});

		it("turning off from on leaves a manual pause", async () => {
			seed(db, {
				holds: opusHold(T0, T0 + 3_600_000),
				paused: true,
				pauseReason: "manual",
			});
			await repo.setAutoPauseOnOverageEnabled("a1", false);
			const acct = await repo.findById("a1");
			expect(acct?.paused).toBe(true);
			expect(acct?.pause_reason).toBe("manual");
			expect(acct?.extra_usage_holds).toBeNull();
		});

		it("posting off for a login already off leaves its overage pause", async () => {
			seed(db, {
				switchOn: false,
				paused: true,
				pauseReason: "overage",
				billedAt: T0,
			});
			expect(await repo.setAutoPauseOnOverageEnabled("a1", false)).toBe(false);
			const acct = await repo.findById("a1");
			expect(acct?.paused).toBe(true);
			expect(acct?.pause_reason).toBe("overage");
			expect(acct?.overage_billed_at).toBe(T0);
		});

		it("posting on for a login already on keeps its stored holds", async () => {
			const stored = opusHold(T0, T0 + 3_600_000);
			seed(db, { holds: stored });
			expect(
				await repo.setAutoPauseOnOverageEnabled("a1", true, {
					readingAt: T0 + 1,
					holds: [],
				}),
			).toBe(false);
			expect((await repo.findById("a1"))?.extra_usage_holds).toEqual(stored);
		});
	});
});
