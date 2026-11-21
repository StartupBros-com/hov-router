---
title: A recovery signal must come from a check the router runs itself, not from traffic the account serves
date: 2026-11-21
category: architecture-patterns
module: alerts
problem_type: architecture_pattern
component: observability
severity: medium
applies_when:
  - Adding an alert, card state or status that clears when an account recovers from a refusal, bench or hold
  - Keying a recovered or ready-again signal to a successful proxied request
  - Changing how drain-soonest or another strategy ranks an account that has no usage data
  - Changing what the usage poll records when a check fails
root_cause: incorrect_assumption
resolution_type: code_fix
related_components:
  - usage poll
  - drain-soonest ranking
  - account status classifier
tags: [recovery-signal, org-permission-denied, usage-poll, drain-soonest, alert-episode, starved-account, account-status]
---

# A recovery signal must come from a check the router runs itself, not from traffic the account serves

## Context

The `org_permission_denied` alert (#877) opens an episode when Anthropic refuses an account's organization: a 403 `permission_error` with `oauth_not_allowed_for_organization`, which a failed subscription payment causes. As first built, it closed the episode with a recovered alert only on the first successful request the account served after its latest refusal (`noteOrgRefusalRecovery`, `packages/http-api/src/services/alerts.ts:2363-2377`).

That design assumed live traffic keeps probing a refused account. When #877 was built, the explanation given was that the router retries the account every couple of minutes, and the first request Anthropic accepts clears the bench. The case of a refused account drawing no traffic was never raised (session history). The assumption held on 2026-11-16: max-primary-bros was refused after a failed payment and recovered through ordinary traffic, with its first 200 at 22:09:36Z (auto memory [claude]).

On 2026-11-21 it did not hold. max-quaternary-spgm was refused at 06:30:55Z after a failed payment, and the refused alert fired. The account then served no request for the rest of the day: the `requests` table has no row with its id in `account_used` for 2026-11-21. The invoice was paid around 21:00Z, and a Refresh usage at 21:09:30Z was accepted. Nothing closed the episode, and the 21:55Z deploy dropped it from memory, so the recovered alert never fired. For about 14.5 hours the account card also read Ready, because the card counted a refusal only while the router's bench was live, and the bench set that morning lapsed after 30 s.

## Guidance

Before keying a recovered, healthy or ready-again signal to served traffic, check whether the condition being recovered from also takes the account out of routing. If it can, take the signal from a check the router runs on its own schedule. For Anthropic accounts that check is the usage poll.

How a refused Anthropic account loses its traffic:

1. The usage endpoint refuses the account with the same 403, so the poll stores no usage for it.
2. A cached usage entry expires after 10 minutes (`USAGE_CACHE_MAX_AGE_MS`, `packages/providers/src/usage-fetcher.ts:65`), and `get()` deletes an expired entry when it reads it (`usage-fetcher.ts:1735-1748`).
3. With no entry, the strategy store's `getAccountWeeklyReset` returns null (`apps/server/src/server.ts:2206-2211`).
4. With no usage snapshot, the account has no weekly pace band either: one is computed only from a snapshot (`packages/proxy/src/handlers/account-selector.ts:1579-1584`). The structural compare orders by fallback rung, then tier, and compares pace bands only when both accounts have one (`packages/load-balancer/src/strategies/routing-metadata.ts:190-213`). That leaves the weekly reset to decide, and drain-soonest sorts an account with no known reset after every account that has one (`packages/load-balancer/src/strategies/session-drain-soonest.ts:261-266`).

So while any other account can take the request, the refused account gets nothing, and a signal that waits for its traffic never fires.

#943 (issue #941) applied the pattern:

- The usage poll classifies its own answer. `isUsageOrgRefusal` (`usage-fetcher.ts:333`) counts a 403 as an organization refusal only when `error.type` is `permission_error` and `details.error_code` is `oauth_not_allowed_for_organization`.
- One shared method, `noteOrgUsageCheck` (`usage-fetcher.ts:2197`), records each verdict. Both the poll (`usage-fetcher.ts:1621`) and the Clear cooldown fallback call it. It keeps `usageOrgRefusedAt` until a check returns usage, and publishes a `usage` event for each refused or accepted check. Any other failure leaves the record as it is and publishes nothing.
- The card reads that record (`packages/ui-common/src/account-status.ts:155-158`). It shows Anthropic refused while the usage check is refused, unless a live bench for another cause is set.
- The alert service opens an episode on a refused usage check and closes it on an accepted check that started after the latest refusal (`handleOrgUsageCheck`, `alerts.ts:2272-2299`). The served-request path still closes episodes too.

Keep each source's evidence to what it can show. An accepted usage check closes only an episode in which a usage check was refused (`alerts.ts:2275`), because the usage endpoint answering says nothing about requests when only requests were refused. That remaining case is not starved. By steps 2 to 4, an account whose usage check is accepted has usage data and a weekly reset, and so keeps its normal place in the ranking and still gets traffic.

## Why This Matters

A recovery signal that waits for traffic fails silently, at the moment the operator most needs it. The operator pays the invoice or fixes the login, and the alert that should confirm it never arrives. Meanwhile the card is wrong in one direction or the other. Here it read Ready while Anthropic was still refusing the account.

The delay also loses the signal outright. Alert episodes live in memory, so any restart between the recovery and the moment the signal finally fires drops the episode, as the 21:55Z deploy did on 2026-11-21. A poll bounds that gap to one poll interval, and a Refresh usage closes it at once.

## When to Apply

- A new alert episode, account status or card state that clears on recovery.
- A condition that empties an account's usage data, holds a long bench, pauses it or otherwise moves it to the back of the ranking.
- A design note that says the router will retry the account anyway. Check the ranking code, not just the bench length: max-quaternary-spgm's bench lapsed after 30 s, and the account still drew no traffic for 14.5 hours.

## Examples

Before #943, this served-request path was the only way to close an episode. It is still there (`alerts.ts:2363-2377`, shortened):

```ts
async noteOrgRefusalRecovery(request: RequestResponse): Promise<void> {
	if (!request.accountUsed || !request.success) return;
	// ...
	const open = this.orgRefusals.get(request.accountUsed);
	if (!open) return;
	const startedAt = Date.parse(request.timestamp);
	if (!Number.isFinite(startedAt) || startedAt <= open.lastRefusedAt) return;
	await this.closeOrgRefusal(request.accountUsed, open, startedAt, request.id);
}
```

Since #943, the usage poll's verdict also closes it, without waiting for traffic (`alerts.ts:2272-2277`):

```ts
async handleOrgUsageCheck(event: OrgUsageCheckEvt): Promise<void> {
	if (event.outcome === "accepted") {
		const open = this.orgRefusals.get(event.accountId);
		if (!open?.usageRefused || event.startedAt <= open.lastRefusedAt) return;
		await this.closeOrgRefusal(event.accountId, open, event.startedAt, null);
		return;
	}
	// a refused check opens or extends the episode for an unpaused account
}
```

## Related

- [Configuration: the `org_permission_denied` alert](../../configuration.md) describes the alert, the usage-check rules and the card for operators.
- [Rate-limit scope and duration](../rate-limit-scope-and-duration.md) covers the evidence for putting an account on a bench. This doc covers the evidence for taking it off.
- [The collapsed Accounts row says each fact once](../design-patterns/accounts-row-says-each-fact-once.md) defines the refused card state this record now drives.
- [Validate against live payloads](../validate-against-live-payloads.md): the strict usage 403 check was written against the real 2026-11-21 response body.
- Issues #877 (the alert), #941 (the bug) and #869 (the live-bench rule for the card), and PR #943 (the fix).
