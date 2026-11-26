import { expect, test } from "bun:test";
import type {
	Account,
	AccountDisplay,
	AccountResponse,
} from "@hov-router/types";
import { classifyAccountStatus } from "./account-status";
import { AccountPresenter } from "./presenters";

const now = 100000;
test("normal, soft and unknown observations never claim rejection", () => {
	for (const status of ["OK", "ok (12m)", "Allowed", "allowed (1m)"])
		expect(classifyAccountStatus({ rateLimitStatus: status }, now).reason).toBe(
			"normal",
		);
	for (const status of ["allowed_warning", "queueing_soft (2m)"]) {
		const s = classifyAccountStatus({ rateLimitStatus: status }, now);
		expect(s.reason).toBe("normal");
		expect(s.notices).toContain("soft-warning");
		expect(s.overview).toBe(false);
	}
	const s = classifyAccountStatus({ rateLimitStatus: "future_value" }, now);
	expect(s.reason).toBe("unknown");
	expect(s.reportedStatus).toBe("future_value");
	expect(s.overview).toBe(false);
});
test("labels state the routing outcome instead of a negation", () => {
	const examples = [
		{ input: { rateLimitStatus: "allowed" }, label: "Ready" },
		{ input: {}, label: "Ready" },
		{ input: { usageRateLimitedUntil: now + 1 }, label: "Ready" },
		{
			input: { rateLimitStatus: "allowed_warning" },
			label: "Provider warning",
		},
		{
			input: { rateLimitStatus: "queueing_soft (2m)" },
			label: "Provider warning",
		},
		{ input: { rateLimitedUntil: now + 1 }, label: "Cooling down" },
		{ input: { rateLimitStatus: "usage_exhausted" }, label: "Usage exhausted" },
		{ input: { rateLimitStatus: "blocked" }, label: "Reported hard limit" },
		{ input: { usageThrottledUntil: now + 1 }, label: "Pacing active" },
		{ input: { rateLimitStatus: "future_status" }, label: "Status unknown" },
		{ input: { paused: true }, label: "Paused" },
		{
			input: { paused: true, requiresReauth: true },
			label: "Reconnect required",
		},
	];
	for (const { input, label } of examples) {
		expect(classifyAccountStatus(input, now).label).toBe(label);
	}
	for (const input of examples.map((e) => e.input))
		expect(classifyAccountStatus(input, now).label).not.toBe("Not blocked");
});
test("presentation colors distinguish clear, caution, blocked and paused states", () => {
	const examples = [
		{ input: { rateLimitStatus: "allowed" }, tone: "ok" },
		{ input: { rateLimitStatus: "OK" }, tone: "ok" },
		{ input: { rateLimitStatus: "allowed_warning" }, tone: "warning" },
		{ input: { rateLimitStatus: "queueing_soft" }, tone: "warning" },
		{ input: { usageRateLimitedUntil: now + 1 }, tone: "warning" },
		{ input: { usageThrottledUntil: now + 1 }, tone: "warning" },
		{ input: { rateLimitStatus: "future_status" }, tone: "warning" },
		{ input: { rateLimitedUntil: now + 1 }, tone: "bad" },
		{ input: { rateLimitStatus: "usage_exhausted" }, tone: "bad" },
		{ input: { rateLimitStatus: "blocked" }, tone: "bad" },
		{ input: { paused: true, requiresReauth: true }, tone: "bad" },
		{ input: { paused: true }, tone: "muted" },
	];
	for (const { input, tone } of examples) {
		expect(classifyAccountStatus(input, now).tone).toBe(tone);
	}
});
test("precedence, independent signals and frozen clear-cooldown predicate", () => {
	const a = {
		rateLimitStatus: "usage_exhausted (90m)",
		rateLimitedUntil: now + 10,
		usageThrottledUntil: now + 20,
		usageRateLimitedUntil: now + 30,
	};
	expect(classifyAccountStatus(a, now).reason).toBe("cooldown");
	expect(classifyAccountStatus({ ...a, paused: true }, now).reason).toBe(
		"paused",
	);
	expect(
		classifyAccountStatus({ ...a, paused: true, requiresReauth: true }, now)
			.reason,
	).toBe("reauth");
	const exhausted = classifyAccountStatus(
		{ ...a, rateLimitedUntil: null },
		now,
	);
	expect(exhausted.reason).toBe("exhausted");
	expect(exhausted.clearCooldown).toBe(false);
	expect(exhausted.capacityAttention).toBe(true);
	expect(exhausted.refreshDelayed).toBe(true);
	for (const status of [
		"rate_limited",
		"blocked",
		"queueing_hard",
		"payment_required",
	])
		expect(
			classifyAccountStatus({ rateLimitStatus: status }, now).clearCooldown,
		).toBe(true);
	expect(
		classifyAccountStatus({ rateLimitStatus: "Rate limited (2m)" }, now)
			.clearCooldown,
	).toBe(false);
});
test("API-generated cooldown labels expire with their numeric deadline", () => {
	const snapshot = {
		rateLimitStatus: "Rate limited (1m)",
		rateLimitedUntil: now + 30_000,
	};
	expect(classifyAccountStatus(snapshot, now).reason).toBe("cooldown");
	for (const clock of [
		snapshot.rateLimitedUntil,
		snapshot.rateLimitedUntil + 1,
	]) {
		const status = classifyAccountStatus(snapshot, clock);
		expect(status.reason).toBe("normal");
		expect(status.label).toBe("Ready");
		expect(status.capacityAttention).toBe(false);
		expect(status.overview).toBe(false);
		expect(status.clearCooldown).toBe(false);
		expect(status.reportedStatus).toBe(snapshot.rateLimitStatus);
	}
	expect(
		classifyAccountStatus(
			{ ...snapshot, usageThrottledUntil: now + 60_000 },
			snapshot.rateLimitedUntil,
		).reason,
	).toBe("pacing");
});
test("cooldown expiry preserves independent hard statuses and unknown deadlines", () => {
	for (const rateLimitStatus of [
		"rate_limited (1m)",
		"blocked",
		"queueing_hard",
		"payment_required",
		"Rate limited",
		"Rate limited until tomorrow",
	]) {
		const status = classifyAccountStatus(
			{ rateLimitStatus, rateLimitedUntil: now },
			now,
		);
		expect(status.reason).toBe("hard-limit");
		expect(status.capacityAttention).toBe(true);
	}
	for (const rateLimitedUntil of [undefined, null, NaN, Infinity]) {
		expect(
			classifyAccountStatus(
				{
					rateLimitStatus: "Rate limited (1m)",
					rateLimitedUntil,
				},
				now,
			).reason,
		).toBe("hard-limit");
	}
});
test("finite future clocks only, no utilization-derived exhaustion", () => {
	for (const until of [now, now - 1, NaN, Infinity]) {
		const s = classifyAccountStatus(
			{
				usageThrottledUntil: until,
				usageRateLimitedUntil: until,
				rateLimitedUntil: until,
			},
			now,
		);
		expect(s.reason).toBe("normal");
		expect(s.refreshDelayed).toBe(false);
	}
	expect(
		classifyAccountStatus({ usageRateLimitedUntil: now + 1 }, now).overview,
	).toBe(false);
	expect(
		classifyAccountStatus({ usageThrottledUntil: now + 1 }, now).reason,
	).toBe("pacing");
});
test("an Anthropic org refusal names the refusal instead of offering Clear cooldown", () => {
	const until = now + 60_000;
	const refused = classifyAccountStatus(
		{ rateLimitedUntil: until, rateLimitedReason: "org_permission_denied" },
		now,
	);
	expect(refused.reason).toBe("refused");
	expect(refused.label).toBe("Anthropic refused");
	expect(refused.tone).toBe("bad");
	expect(refused.clearCooldown).toBe(false);
	expect(refused.capacityAttention).toBe(true);
	expect(refused.overview).toBe(true);
	expect(refused.routerRetryAt).toBe(until);
	expect(refused.hint).toContain("billing");
	expect(refused.hint).toContain("Claude Code access");
	// A stored hard status would otherwise offer the button on its own.
	expect(
		classifyAccountStatus(
			{
				rateLimitStatus: "rate_limited",
				rateLimitedUntil: until,
				rateLimitedReason: "org_permission_denied",
			},
			now,
		).clearCooldown,
	).toBe(false);
	// Paused and reconnect still outrank the refusal.
	const benched = {
		rateLimitedUntil: until,
		rateLimitedReason: "org_permission_denied",
	};
	expect(classifyAccountStatus({ ...benched, paused: true }, now).reason).toBe(
		"paused",
	);
	expect(
		classifyAccountStatus({ ...benched, requiresReauth: true }, now).reason,
	).toBe("reauth");
});
test("only a live org-refusal bench reads as refused", () => {
	const other = classifyAccountStatus(
		{
			rateLimitedUntil: now + 60_000,
			rateLimitedReason: "upstream_429_with_reset",
		},
		now,
	);
	expect(other.reason).toBe("cooldown");
	expect(other.label).toBe("Cooling down");
	expect(other.clearCooldown).toBe(true);
	expect(other.hint).toBeNull();
	// The state the account is left in after recovery: reason kept, bench over.
	for (const rateLimitedUntil of [now, now - 1, null]) {
		const expired = classifyAccountStatus(
			{ rateLimitedUntil, rateLimitedReason: "org_permission_denied" },
			now,
		);
		expect(expired.reason).toBe("normal");
		expect(expired.label).toBe("Ready");
		expect(expired.hint).toBeNull();
	}
});
test("a live 402 bench names payment required, its retry and Clear cooldown (#1025)", () => {
	const until = now + 60_000;
	for (const rateLimitStatus of [
		"Rate limited (1m)",
		"payment_required (1m)",
		undefined,
	]) {
		const payment = classifyAccountStatus(
			{
				rateLimitStatus,
				rateLimitedUntil: until,
				rateLimitedReason: "upstream_402_payment_required",
			},
			now,
		);
		expect(payment.reason).toBe("payment");
		expect(payment.label).toBe("Payment required");
		expect(payment.tone).toBe("bad");
		expect(payment.routerRetryAt).toBe(until);
		// Once billing is fixed, clearing the bench retries at once.
		expect(payment.clearCooldown).toBe(true);
		expect(payment.capacityAttention).toBe(true);
		expect(payment.overview).toBe(true);
		expect(payment.hint).toContain("billing or credits");
	}
	const benched = {
		rateLimitedUntil: until,
		rateLimitedReason: "upstream_402_payment_required",
	};
	expect(classifyAccountStatus({ ...benched, paused: true }, now).reason).toBe(
		"paused",
	);
	expect(
		classifyAccountStatus({ ...benched, requiresReauth: true }, now).reason,
	).toBe("reauth");
	// The expiry sweep lifts the bench after about a minute but keeps the
	// reason and rate_limited_at, and nothing has served since: still unpaid.
	for (const rateLimitedUntil of [now, now - 1, null]) {
		const lapsed = classifyAccountStatus(
			{ ...benched, rateLimitedUntil, rateLimitedAt: now - 120_000 },
			now,
		);
		expect(lapsed.reason).toBe("payment");
		expect(lapsed.label).toBe("Payment required");
		expect(lapsed.tone).toBe("bad");
		expect(lapsed.hint).toContain("billing or credits");
		expect(lapsed.routerRetryAt).toBeNull();
		// Clear cooldown is how the operator dismisses it once billing is fixed.
		expect(lapsed.clearCooldown).toBe(true);
		expect(lapsed.capacityAttention).toBe(true);
		expect(lapsed.overview).toBe(true);
		expect(
			classifyAccountStatus(
				{ ...benched, rateLimitedUntil, rateLimitedAt: now, paused: true },
				now,
			).capacityAttention,
		).toBe(false);
	}
	// A request served more than 5 minutes after the 402 clears
	// rate_limited_at, and with it the claim; the stored reason stays behind.
	for (const rateLimitedAt of [null, undefined, Number.NaN]) {
		const recovered = classifyAccountStatus(
			{ ...benched, rateLimitedUntil: null, rateLimitedAt },
			now,
		);
		expect(recovered.reason).toBe("normal");
		expect(recovered.label).toBe("Ready");
		expect(recovered.hint).toBeNull();
		expect(recovered.clearCooldown).toBe(false);
	}
	// xAI's 402 is a capacity signal, not billing, and stays a cooldown.
	for (const rateLimitedReason of [
		"xai_capacity_402",
		"upstream_429_with_reset",
	]) {
		const other = classifyAccountStatus(
			{ rateLimitedUntil: until, rateLimitedReason },
			now,
		);
		expect(other.reason).toBe("cooldown");
		expect(other.label).toBe("Cooling down");
		expect(other.hint).toBeNull();
	}
});
test("a refused usage check reads as refused after the router's bench lapses (#941)", () => {
	// max-quaternary-spgm on 2026-11-21: the 30 s bench was long over, but
	// every usage check was still refused, and the card said Ready.
	const usageRefused = {
		provider: "anthropic",
		rateLimitedUntil: null,
		rateLimitedReason: "org_permission_denied",
		usageOrgRefusedAt: now - 60_000,
	};
	const refused = classifyAccountStatus(usageRefused, now);
	expect(refused.reason).toBe("refused");
	expect(refused.label).toBe("Anthropic refused");
	expect(refused.tone).toBe("bad");
	expect(refused.hint).toContain("billing");
	expect(refused.capacityAttention).toBe(true);
	expect(refused.overview).toBe(true);
	expect(refused.clearCooldown).toBe(false);
	expect(refused.routerRetryAt).toBeNull();
	// The usage check alone is enough; the stored reason is not needed.
	expect(
		classifyAccountStatus({ usageOrgRefusedAt: now - 60_000 }, now).reason,
	).toBe("refused");
	// Paused and reconnect still outrank the refusal, and a paused account's
	// refusal does not nag under needs attention.
	const paused = classifyAccountStatus({ ...usageRefused, paused: true }, now);
	expect(paused.reason).toBe("paused");
	expect(paused.capacityAttention).toBe(false);
	expect(
		classifyAccountStatus({ ...usageRefused, requiresReauth: true }, now)
			.reason,
	).toBe("reauth");
	// A live bench for another cause is fresher than the usage check (a
	// served request does not clear the record), so it shows as a cooldown
	// the operator can clear.
	const otherBench = classifyAccountStatus(
		{
			...usageRefused,
			rateLimitedUntil: now + 60_000,
			rateLimitedReason: "upstream_429",
		},
		now,
	);
	expect(otherBench.reason).toBe("cooldown");
	expect(otherBench.clearCooldown).toBe(true);
	// A live org-refusal bench is still a refusal.
	expect(
		classifyAccountStatus(
			{ ...usageRefused, rateLimitedUntil: now + 60_000 },
			now,
		).reason,
	).toBe("refused");
	// No record, or a malformed one, is not a refusal.
	for (const usageOrgRefusedAt of [null, undefined, Number.NaN]) {
		const ready = classifyAccountStatus(
			{ ...usageRefused, usageOrgRefusedAt },
			now,
		);
		expect(ready.reason).toBe("normal");
		expect(ready.label).toBe("Ready");
		expect(ready.capacityAttention).toBe(false);
	}
});
test("presenter carries the raw rate-limit reason into the status", () => {
	const raw = {
		paused: false,
		rate_limited_until: now + 60_000,
		rate_limited_reason: "org_permission_denied",
		pause_reason: null,
	};
	expect(
		new AccountPresenter(raw as unknown as Account, now).status.reason,
	).toBe("refused");
	// A lapsed 402 bench needs rate_limited_at carried through too (#1025).
	const lapsed402 = {
		paused: false,
		rate_limited_until: null,
		rate_limited_reason: "upstream_402_payment_required",
		rate_limited_at: now - 120_000,
		pause_reason: null,
	};
	expect(
		new AccountPresenter(lapsed402 as unknown as Account, now).status.reason,
	).toBe("payment");
	expect(
		new AccountPresenter(
			{ ...lapsed402, rate_limited_at: null } as unknown as Account,
			now,
		).status.reason,
	).toBe("normal");
});
test("presenter supports raw, response and display inputs without rewriting raw strings", () => {
	for (const account of [
		{ paused: false, rate_limited_until: now + 1, pause_reason: null },
		{ paused: false, rateLimitStatus: "allowed", rateLimitedUntil: now + 1 },
		{ paused: false, rateLimitStatus: "queueing_soft" },
	]) {
		const p = new AccountPresenter(
			account as Account | AccountResponse | AccountDisplay,
			now,
		);
		expect(typeof p.rateLimitStatus).toBe("string");
		expect(p.status.reason).toBe(
			"rate_limited_until" in account || "rateLimitedUntil" in account
				? "cooldown"
				: "normal",
		);
	}
});

// #917: an Anthropic account's soft notice comes from the weekly usage poll.
const WEEK_MS = 7 * 86_400_000;
const futureReset = new Date(now + WEEK_MS).toISOString();
const pastReset = new Date(now - 1_000).toISOString();
function weeklyAll(percent: number | null, resets_at = futureReset) {
	return { kind: "weekly_all", percent, resets_at, is_active: true };
}
function weeklyScoped(name: string, percent: number, resets_at = futureReset) {
	return {
		kind: "weekly_scoped",
		percent,
		resets_at,
		// The live poll reports Fable with is_active false; it still counts.
		is_active: false,
		scope: { model: { id: null, display_name: name }, surface: null },
	};
}
function anthropic(usageData: unknown, rateLimitStatus = "OK") {
	return { provider: "anthropic", usageData, rateLimitStatus } as never;
}

test("a stored allowed_warning with a fresh poll under 75% is Ready", () => {
	const s = classifyAccountStatus(
		anthropic(
			{ limits: [weeklyAll(0), weeklyScoped("Fable", 0)] },
			"allowed_warning (652m)",
		),
		now,
	);
	expect(s.label).toBe("Ready");
	expect(s.tone).toBe("ok");
	expect(s.notices).not.toContain("soft-warning");
	expect(s.weeklyLimitNotice).toBeNull();
});
test("a poll at 80% on the Fable weekly cap shows Near weekly limit with no header status", () => {
	const s = classifyAccountStatus(
		anthropic({ limits: [weeklyAll(10), weeklyScoped("Fable", 80)] }),
		now,
	);
	expect(s.reason).toBe("normal");
	expect(s.label).toBe("Near weekly limit");
	expect(s.tone).toBe("warning");
	expect(s.notices).toContain("soft-warning");
	expect(s.weeklyLimitNotice).toEqual({ percent: 80, window: "Fable weekly" });
	expect(s.overview).toBe(false);
	expect(s.capacityAttention).toBe(false);
});
test("the threshold is Anthropic's own 75%", () => {
	expect(
		classifyAccountStatus(anthropic({ limits: [weeklyAll(75)] }), now).label,
	).toBe("Near weekly limit");
	expect(
		classifyAccountStatus(anthropic({ limits: [weeklyAll(74.9)] }), now).label,
	).toBe("Ready");
});
test("a full window is at its limit, not near it, so it leaves the pill to the others", () => {
	const fullFable = classifyAccountStatus(
		anthropic({ limits: [weeklyAll(32), weeklyScoped("Fable", 100)] }),
		now,
	);
	expect(fullFable.label).toBe("Ready");
	expect(fullFable.weeklyLimitNotice).toBeNull();
	const fullFableNearAll = classifyAccountStatus(
		anthropic({ limits: [weeklyAll(80), weeklyScoped("Fable", 100)] }),
		now,
	);
	expect(fullFableNearAll.label).toBe("Near weekly limit");
	expect(fullFableNearAll.weeklyLimitNotice).toEqual({
		percent: 80,
		window: "Weekly",
	});
});
test("a window whose reset has passed never raises the notice", () => {
	const s = classifyAccountStatus(
		anthropic({ limits: [weeklyAll(95, pastReset)] }),
		now,
	);
	expect(s.label).toBe("Ready");
	expect(s.weeklyLimitNotice).toBeNull();
	const noReset = classifyAccountStatus(
		anthropic({ limits: [{ ...weeklyAll(80), resets_at: null }] }),
		now,
	);
	expect(noReset.label).toBe("Near weekly limit");
});
test("legacy flat weekly windows count when limits[] has no usable rows", () => {
	for (const usageData of [
		{ seven_day_fable: { utilization: 80, resets_at: futureReset } },
		{
			limits: [weeklyAll(null)],
			seven_day: { utilization: 90, resets_at: futureReset },
		},
	]) {
		const s = classifyAccountStatus(anthropic(usageData), now);
		expect(s.label).toBe("Near weekly limit");
	}
	expect(
		classifyAccountStatus(
			anthropic({
				seven_day_fable: { utilization: 80, resets_at: futureReset },
			}),
			now,
		).weeklyLimitNotice,
	).toEqual({ percent: 80, window: "Fable weekly" });
});
test("with no poll the stored header no longer raises the notice", () => {
	const s = classifyAccountStatus(anthropic(null, "allowed_warning"), now);
	expect(s.label).toBe("Ready");
	expect(s.notices).not.toContain("soft-warning");
});
test("the notice is only for an otherwise Ready account", () => {
	const exhausted = classifyAccountStatus(
		anthropic({ limits: [weeklyAll(100)] }, "usage_exhausted (1312m)"),
		now,
	);
	expect(exhausted.reason).toBe("exhausted");
	expect(exhausted.notices).not.toContain("soft-warning");
	expect(exhausted.weeklyLimitNotice).toBeNull();
	const paused = classifyAccountStatus(
		{ ...(anthropic({ limits: [weeklyAll(90)] }) as object), paused: true },
		now,
	);
	expect(paused.label).toBe("Paused");
	expect(paused.notices).not.toContain("soft-warning");
	const cooling = classifyAccountStatus(
		{
			...(anthropic({ limits: [weeklyAll(90)] }) as object),
			rateLimitedUntil: now + 60_000,
		},
		now,
	);
	expect(cooling.label).toBe("Cooling down");
	expect(cooling.notices).not.toContain("soft-warning");
});
test("providers without a weekly poll keep the header-based Provider warning", () => {
	const s = classifyAccountStatus(
		{
			provider: "anthropic-compatible",
			rateLimitStatus: "allowed_warning",
		} as never,
		now,
	);
	expect(s.label).toBe("Provider warning");
	expect(s.notices).toContain("soft-warning");
	expect(s.weeklyLimitNotice).toBeNull();
});
test("the presenter passes an API account's poll through", () => {
	const account = {
		paused: false,
		provider: "anthropic",
		rateLimitStatus: "allowed_warning (652m)",
		usageData: { limits: [weeklyAll(96), weeklyScoped("Fable", 1)] },
	};
	const p = new AccountPresenter(account as unknown as AccountResponse, now);
	expect(p.rateLimitStatus).toBe("allowed_warning (652m)");
	expect(p.status.label).toBe("Near weekly limit");
	expect(p.status.weeklyLimitNotice).toEqual({ percent: 96, window: "Weekly" });
});
