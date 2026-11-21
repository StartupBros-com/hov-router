import { afterEach, describe, expect, it } from "bun:test";
import {
	type OrgUsageCheckEvt,
	orgPermissionDeniedEvents,
} from "@better-ccflare/core";
import {
	fetchUsageData,
	isUsageOrgRefusal,
	usageCache,
} from "../usage-fetcher";

// Issue #941: on 2026-11-21 Anthropic refused max-quaternary-spgm for about
// 14.5 hours after a failed payment. Its usage check got this 403 about every
// 30 minutes, but the fetcher returned only `data: null`, so the card read
// Ready and the recovered alert waited for traffic the account never got.

/** The usage endpoint's answer at 2026-11-21T06:31:16Z, verbatim. */
const REFUSAL_BODY =
	'{"type":"error","error":{"type":"permission_error","message":"OAuth authentication is currently not allowed for this organization.","details":{"error_visibility":"user_facing","error_code":"oauth_not_allowed_for_organization"}},"request_id":"req_011ChFbyQaU6pgAbsJ8dhFx9"}';

const NO_CODE_BODY =
	'{"type":"error","error":{"type":"permission_error","message":"OAuth token does not meet scope requirement user:profile"}}';

function jsonResponse(status: number, body: string): Response {
	return new Response(body, {
		status,
		headers: {
			"content-type": "application/json",
			"x-should-retry": "false",
		},
	});
}

const refusal = () => jsonResponse(403, REFUSAL_BODY);
const usage = () =>
	Response.json({
		seven_day: {
			utilization: 0,
			resets_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
		},
	});

const originalFetch = globalThis.fetch;
const started: string[] = [];
let nextId = 0;

function accountId(): string {
	const id = `usage-org-refusal-${++nextId}`;
	started.push(id);
	return id;
}

/** Stubbed endpoint: answers in order, then repeats the last answer. */
function stubFetch(answers: (() => Response)[]): { count: () => number } {
	let calls = 0;
	globalThis.fetch = (async () => {
		const answer = answers[Math.min(calls, answers.length - 1)];
		calls++;
		return answer();
	}) as unknown as typeof fetch;
	return { count: () => calls };
}

async function until(predicate: () => boolean, timeoutMs = 2_000) {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("condition never held");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function recordUsageChecks(): {
	events: OrgUsageCheckEvt[];
	stop: () => void;
} {
	const events: OrgUsageCheckEvt[] = [];
	const listener = (event: OrgUsageCheckEvt) => events.push(event);
	orgPermissionDeniedEvents.on("usage", listener);
	return {
		events,
		stop: () => orgPermissionDeniedEvents.off("usage", listener),
	};
}

let stopRecording: (() => void) | null = null;

afterEach(() => {
	stopRecording?.();
	stopRecording = null;
	for (const id of started.splice(0)) {
		usageCache.stopPolling(id);
		usageCache.delete(id);
	}
	globalThis.fetch = originalFetch;
});

describe("isUsageOrgRefusal", () => {
	it("matches the real usage-endpoint refusal", () => {
		expect(isUsageOrgRefusal(403, REFUSAL_BODY)).toBe(true);
	});

	it("needs the error code: a permission_error without it may be a scope problem", () => {
		expect(isUsageOrgRefusal(403, NO_CODE_BODY)).toBe(false);
		expect(
			isUsageOrgRefusal(
				403,
				REFUSAL_BODY.replace(
					"oauth_not_allowed_for_organization",
					"some_other_code",
				),
			),
		).toBe(false);
	});

	it("matches no other status and no non-JSON body", () => {
		expect(isUsageOrgRefusal(429, REFUSAL_BODY)).toBe(false);
		expect(isUsageOrgRefusal(401, REFUSAL_BODY)).toBe(false);
		expect(isUsageOrgRefusal(200, REFUSAL_BODY)).toBe(false);
		expect(isUsageOrgRefusal(403, "<html>blocked</html>")).toBe(false);
		expect(isUsageOrgRefusal(403, "")).toBe(false);
	});
});

describe("fetchUsageData", () => {
	it("reports an organization refusal", async () => {
		stubFetch([refusal]);
		const result = await fetchUsageData("fake-token");
		expect(result.data).toBeNull();
		expect(result.orgRefused).toBe(true);
	});

	it("does not report a refusal for usage or for another 403", async () => {
		stubFetch([usage]);
		expect((await fetchUsageData("fake-token")).orgRefused).toBeFalsy();
		stubFetch([() => jsonResponse(403, NO_CODE_BODY)]);
		expect((await fetchUsageData("fake-token")).orgRefused).toBeFalsy();
	});
});

describe.serial("usage cache org refusal record", () => {
	it.serial(
		"records a refused check, keeps it across a polling restart, and clears it when usage returns",
		async () => {
			const id = accountId();
			const recorder = recordUsageChecks();
			stopRecording = recorder.stop;
			const endpoint = stubFetch([refusal, usage]);
			const before = Date.now();
			usageCache.startPolling(id, "fake-token", "anthropic", 60_000);
			await until(() => usageCache.getOrgRefusedAt(id) !== null);
			expect(endpoint.count()).toBe(1);
			expect(usageCache.getOrgRefusedAt(id)).toBeGreaterThanOrEqual(before);

			const refused = recorder.events.filter((e) => e.accountId === id);
			expect(refused).toHaveLength(1);
			expect(refused[0]?.outcome).toBe("refused");
			expect(refused[0]?.startedAt).toBeGreaterThanOrEqual(before);
			expect(refused[0]?.answeredAt).toBeGreaterThanOrEqual(
				refused[0]?.startedAt ?? Number.POSITIVE_INFINITY,
			);

			// Refresh usage restarts polling: the record outlives the stop, and
			// the restarted poll's immediate check replaces it.
			usageCache.stopPolling(id);
			expect(usageCache.getOrgRefusedAt(id)).not.toBeNull();
			usageCache.startPolling(id, "fake-token", "anthropic", 60_000);
			await until(() => usageCache.getOrgRefusedAt(id) === null);
			expect(endpoint.count()).toBe(2);

			const accepted = recorder.events.filter(
				(e) => e.accountId === id && e.outcome === "accepted",
			);
			expect(accepted).toHaveLength(1);
			expect(accepted[0]?.startedAt).toBeGreaterThanOrEqual(
				refused[0]?.answeredAt ?? Number.POSITIVE_INFINITY,
			);
		},
	);

	it.serial(
		"keeps the record through a check that says nothing about the organization",
		async () => {
			const id = accountId();
			const endpoint = stubFetch([
				refusal,
				() => new Response("upstream down", { status: 500 }),
			]);
			usageCache.startPolling(id, "fake-token", "anthropic", 60_000);
			await until(() => usageCache.getOrgRefusedAt(id) !== null);
			const refusedAt = usageCache.getOrgRefusedAt(id);

			expect(await usageCache.refreshNow(id)).toBe(false);
			expect(endpoint.count()).toBe(2);
			expect(usageCache.getOrgRefusedAt(id)).toBe(refusedAt);
		},
	);

	it.serial("records nothing for another account", async () => {
		const refusedId = accountId();
		const otherId = accountId();
		stubFetch([refusal]);
		usageCache.startPolling(refusedId, "fake-token", "anthropic", 60_000);
		await until(() => usageCache.getOrgRefusedAt(refusedId) !== null);
		expect(usageCache.getOrgRefusedAt(otherId)).toBeNull();
	});

	it.serial("clear() drops the record", async () => {
		const id = accountId();
		stubFetch([refusal]);
		usageCache.startPolling(id, "fake-token", "anthropic", 60_000);
		await until(() => usageCache.getOrgRefusedAt(id) !== null);
		usageCache.clear();
		expect(usageCache.getOrgRefusedAt(id)).toBeNull();
	});
});
