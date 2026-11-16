import { expect, test } from "bun:test";
import type {
	Account,
	AccountDisplay,
	AccountResponse,
} from "@better-ccflare/types";
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
