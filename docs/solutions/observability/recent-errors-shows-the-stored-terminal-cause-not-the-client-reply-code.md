---
title: Recent Errors shows the router's stored failure code, never the error code in the client's reply
date: 2026-11-20
category: observability
module: recent-errors
problem_type: documentation_gap
component: observability
severity: medium
root_cause: incorrect_assumption
applies_when:
  - Writing or reviewing the dashboard's text for a Recent Errors code
  - Tracing an error code a client saw (a reply body, a Claude Code message, a log line) to what the dashboard or the requests table shows
  - Counting or filtering production failures by requests.error_message
  - Crediting a client-visible status and retry-after to the function that built the reply
related_components:
  - proxy
  - dashboard
  - database
tags: [recent-errors, error-message, terminal-cause, routing-terminal, windowless-429, native-quota, dashboard-copy]
---

# Recent Errors shows the router's stored failure code, never the error code in the client's reply

## Context

Issue #918 (fixed by #922 and #925) set out to give every Recent Errors code a plain title. The issue itself, a response-map report written the same day, and a project memory note each mixed up the code a client receives with the code the router stores:

- #918 listed `native_route_temporarily_unavailable` as a code the card showed raw. The card never shows it, because nothing stores it.
- The report and the memory note credited the 529 a client gets after a windowless 429 to `createProtectedAnthropicOverloadResponse`, whose retry-after runs from 5 to 60 seconds. The 529 actually comes from `createNativeQuotaResponse`, with a 10-second retry-after.
- The first draft of the dashboard descriptions was written by reading lists of codes. A review pass then checked each description against the line that writes its code and rejected 25 of them. #922 and #925 rewrote them, and #925's six fixes each got a test pinned to that line.

Nothing in the docs said what `requests.error_message` holds. `docs/database.md` called it "Error details if request failed". The `GET /api/stats/recent-errors` example in `docs/api-http.md` used `overloaded_error`, which reads like the error type in a reply body. Both were corrected alongside this doc.

A related earlier change: #756 (PR #757) made failed upstream responses record a cause, and its session traced how the column gets filled through the usage collector, the routing terminal recorder and the routing-attempt ledger (session history).

## Guidance

**A failed request has two codes, and they usually differ.**

1. The **reply code** is what the client receives: the HTTP status, the error body's `error.type` and `error.code`, and any `retry-after`. The reply builders in `packages/proxy/src/handlers/routing-terminal.ts` and `packages/proxy/src/proxy.ts` produce it.
2. The **stored code** is `requests.error_message`. Recent Errors groups by it: `getRecentErrorGroups` (`packages/database/src/repositories/stats.repository.ts:315`) selects `r.error_message AS error_code` (line 355), and the API returns that as `errorCode`.

**What the stored code is.** It is one of three things: a kind the router chose itself (such as `route_unavailable`, `pool_exhausted` or `force_route_<reason>`), a stream outcome, or `upstream_http_<status>`. One rewrite applies on top. When the kind is `route_unavailable` and at least one upstream attempt ran, the recorder stores the last attempt's cause instead:

```ts
// packages/proxy/src/routing-terminal-recorder.ts:163-168
error:
	message.error === "route_unavailable" &&
	routingAttemptSummary.physicalAttemptCount > 0 &&
	routingAttemptSummary.terminalCause !== "unknown"
		? (routingAttemptSummary.terminalCause ?? message.error)
		: message.error,
```

`terminalCause` is the cause of the latest attempt (`packages/proxy/src/handlers/routing-attempt-ledger.ts:372-374`). Once a row has a routing summary, a later upsert keeps the `error_message` already stored (`packages/database/src/repositories/request.repository.ts:386`), so the value written together with the summary is the one that stays. The header comment and `ROUTER_CODES` in `packages/dashboard-web/src/components/overview/system-status/__tests__/errorCodeMeta.test.ts` list every stored code with the file that writes it.

**Trace a client's code to its stored code through the code paths, never by name.** Start at the builder of the reply the client got. Follow the path that ended the request to what it recorded, and look up that recorded value. Searching Recent Errors or `requests.error_message` for the reply code finds nothing. The likely wrong conclusion is that the failure never happened.

**Write each description from the line that produces the code.** For dashboard text or a report claim, cite the producing `file:line`, and pin the claim with a test that names that fact. A list of codes says what values exist. It does not say when each one is written or what the client saw.

**Bound production queries on `error_message` by timestamp.** An unbounded filter scans the whole `requests` table. It ran for minutes in one earlier session (session history), and this session's unbounded query timed out at 120 seconds.

## Why This Matters

A wrong mapping does damage downstream. Dashboard text describes a cause the code never records. A search for a client's code returns nothing and gets read as "not happening". A retry-after gets credited to the wrong builder, so models of how clients retry are wrong too. In the 7 days to 2026-11-20, 14,870 requests failed after a windowless 429. Over the same week, Recent Errors showed 14,888 rows as `upstream_error`, and none under the code those clients actually received.

## When to Apply

- Before writing or reviewing text in `packages/dashboard-web/src/components/overview/system-status/errorCodeMeta.ts`.
- When an issue, a report or a client log quotes an error code and the question is how often it happens.
- When adding a new reply code or a new stored code: decide which of the two it is, and add a stored one to `ROUTER_CODES` with its producer.

## Examples

**A windowless 429 on a native combo route:**

| Step | What happens | Where |
|---|---|---|
| Anthropic answers 429 with `x-should-retry: true` and no rate-limit headers | Classified as `windowless_429`, scope `request` | `packages/proxy/src/handlers/proxy-operations.ts:5889-5891` |
| The attempt's outcome | Recorded as `upstream_error`, as for every classified attempt failure | `proxy-operations.ts:6257` |
| The account becomes a native temporary failure | Recheck set 10 s out | `packages/proxy/src/proxy.ts:2546-2553`, `proxy.ts:2645` |
| The client's reply | 529 `overloaded_error`, code `native_route_temporarily_unavailable`, `retry-after: 10` | `createNativeQuotaResponse`, `routing-terminal.ts:78-118` |
| What is stored and shown | `upstream_error`, because `route_unavailable` with an attempt becomes the last attempt's cause | `routing-terminal-recorder.ts:163-168` |

On a plain pool without a native-quota combo, the same 429 reaches the client as a 503 `route_unavailable` and is stored as `upstream_error` too. A query on 2026-11-20 joined every `upstream_error` row production still kept to its last routing attempt. A windowless 429 was the last attempt for 16,020 of them: 15,559 had answered the client with a 529 and 461 with a 503.

**Other codes that exist only in the reply.** `native_quota_wait` (a 429 `rate_limit_error` from the same builder, sent while a combo waits for quota, `routing-terminal.ts:93`) and `force_account_model_no_account` (a 503 at `proxy.ts:306`) are never stored. A refused forced-account model request is stored as `force_model_denied` (`proxy.ts:2814-2815`). Outside those builders, `native_quota_wait` appears only as the combo's exhaustion-policy setting, which is a different value.

## Related

- `docs/routing-architecture.md`, the `windowless_429` entry: how the router handles the 429 in this example (#916, PR #919).
- `docs/api-http.md`, `GET /api/stats/recent-errors`: the endpoint the card reads.
- `docs/solutions/rate-limit-scope-and-duration.md`: rate-limit holds and their scope.
- Issues #918 (Recent Errors text and raw codes, PRs #922 and #925) and #756 (failed upstream responses record a cause, PR #757).
