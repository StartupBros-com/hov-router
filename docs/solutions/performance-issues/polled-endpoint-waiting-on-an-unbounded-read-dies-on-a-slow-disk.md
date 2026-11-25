---
title: A polled dashboard endpoint that waits on an unbounded read turns a slow disk into a dead page
date: 2026-11-25
category: performance-issues
module: dashboard-read-path
problem_type: performance_issue
component: database
symptoms:
  - The Accounts page showed "Accounts could not load / The request timed out" while the host disk was 99.6% busy
  - GET /api/accounts waited on the session-totals read, which ran 47 times in 24 hours with a median of 4.1 s and a maximum of 119 s
  - Reloading or waiting for the next poll never brought the page back while the disk stayed busy
root_cause: concurrency
resolution_type: code_fix
severity: high
related_components:
  - api_layer
  - frontend
  - observability
tags: [dashboard-polling, request-deadline, last-good-cache, single-flight, off-thread-reader, interactive-reader, disk-pressure, slow-sql-log, accounts-page]
---

# A polled dashboard endpoint that waits on an unbounded read turns a slow disk into a dead page

## Problem

On 2026-11-24 the Accounts page stopped loading while other workloads saturated the host's disk (#1013). `GET /api/accounts` waited, with no deadline, on one database read. The dashboard abandons a request at 30 s and asks again 60 s later, so once that read took longer than 30 s, no poll ever got an answer.

The mechanism is recorded in the code: the comment above `SLOW_READ_WAIT_MS` in `packages/http-api/src/handlers/accounts.ts`, and the header of `createLastGoodCache` in `packages/http-api/src/utils/last-good-cache.ts`. This doc keeps what the code can't: why the obvious fixes didn't apply, and how to tell whether another endpoint has the same problem.

## Symptoms

- The page said "Accounts could not load / The request timed out" and "Account data unavailable."
- The read was the session-totals aggregate (`StatsRepository.getSessionStats`, on the interactive reader). In the 24 hours to 00:15Z on 2026-11-25 it ran 47 times, with a median of 4.1 s and a maximum of 119 s (production journal, recorded in #1013).
- Refreshing the page or waiting didn't help. Every attempt hit the same slow read.

## What Didn't Work

- **Looking for a bad query plan.** `EXPLAIN QUERY PLAN` showed the right index, `idx_requests_account_timestamp`. The read touches about 12.6k rows, each a random table-page read. Run on its own it took 12 s and then 43 s, using 0.02 s of CPU, while the disk was 99.6% busy. That time is I/O wait, and no index change removes it. A new index would also have meant an index build on a 3.9 GB database during the same disk pressure. When the plan is right and CPU time is near zero, look at the host first: [read-event-loop-stall-host-fields-before-blaming-sql.md](read-event-loop-stall-host-fields-before-blaming-sql.md).
- **Relying on the reader lanes.** Session totals already had the interactive reader to itself (#709), away from the bulk lane's long scans. That kept the read off the main thread, but the request still waited for it to finish, so the page still died at 30 s.
- **Expecting the client to retry.** `HttpClient` (`packages/http-common/src/client.ts`) turns an aborted request into a 408 and does not retry it. The dashboard's `retries: 1` covers other failures only, so the next attempt is the 60 s `refetchInterval` in `useAccounts`. On the serial reader, each of those polls also queued a fresh read behind the one still running.

## Solution

PR #1019 bounds the wait on the request path and keeps the result of a read the request stopped waiting for:

- **One read per key.** `createLastGoodCache` runs at most one load per key, and later callers join it instead of queueing another read on the serial reader.
- **A bounded wait.** A caller waits up to `waitMs` (`SLOW_READ_WAIT_MS`, 2 s, for the Accounts handler). After that it gets the last good value with its `asOf` time, or `null`.
- **A late read is kept.** A load that outlives every waiting caller keeps running and becomes the cached value, so a 43 s read answers the next poll instead of being thrown away.
- **Old values expire.** A value older than `maxAgeMs` (`SESSION_STATS_MAX_AGE_MS`, 10 minutes) is never served.

The response says which case applied. An account gets the earlier totals with `sessionStatsAsOf`, or `sessionStats: null` with `sessionStatsUnavailable: true`. It never gets zeros. Zeros read as an idle account, both to the operator and to anything that ranks accounts by use.

## Why This Works

The page's deadline is set by the client, not by how long the read takes. A request that waits at most 2 s always answers within the 30 s abort. Running one read per key stops polls stacking reads behind a slow one. Keeping the late result means a slow read still produces the data that appears on the next poll.

## Prevention

- **These are two protections, and a read needs the one that matches its failure.** Running a read off the main thread (`queryOffThread`) stops it stalling every API response and stream relay while it runs. A bounded wait with a last good result stops the page that waits on it from dying. A read that blocks a polled page needs both.
- **The reads moved for #1013 have only the first protection.** The change that added this doc moves the requests list, the usage-window list and the two cache-health state reads off the main thread. In the production journal after #1019 was deployed they took up to 5.7 s, 2.3 s and 3.0 s on the main thread, holding every stream for that long. The requests list and `listWindows` now run on the interactive reader. They still wait without a bound, behind session totals, which logged 70 slow reads on that lane between 01:40Z and 19:35Z on 2026-11-25, 7 of them at 30 s or longer. If the Requests or usage-window pages start timing out, give them the last-good pattern next.
- **Lanes are chosen per statement, not per caller.** `listWindows` runs on the interactive reader for every caller: the usage-window page and its shared read service, the public value feed, the window ledger and the rebuild CLI. The cache-health reads stay on the bulk reader beside `fetchBuckets`. For lane behaviour (one read at a time, no fallback to the main thread), see "Reader lane" in `CONCEPTS.md`.
- **Tests that hold this.** `last-good-cache.test.ts` and `accounts-slow-reader.test.ts` cover #1019's behaviour. `off-thread-reads.test.ts` pins each moved read to its lane.
- **A quiet journal proves nothing here.** Production logs at warn level, and the only SQL lines are `Slow main-thread SQL` and `Slow off-thread SQL`, written for statements of 250 ms or more (`SLOW_SQL_STATEMENT_MS` in `packages/database/src/sqlite-statement-timing.ts`). From 2026-11-21, when the journal begins, to 2026-11-25 it held 184,123 router lines and none at INFO or DEBUG. A fast read and a code path that never ran leave the same nothing. To show which thread serves a read, use [verify-worker-thread-lanes-by-per-thread-syscr.md](../workflow-issues/verify-worker-thread-lanes-by-per-thread-syscr.md).
- **Find a statement's slow lines by how its SQL begins, not by its table name.** Each line gives the statement method (`all` for `query`, `get` for `get`, `run` for writes) and only the first 160 characters of the SQL (`FINGERPRINT_MAX_CHARS` in `sqlite-statement-timing.ts`). `listWindows` selects every `usage_windows` column, so its line ends before `FROM usage_windows`, and a search for the table name finds none of its lines. Five other reads begin the same way: three keyed `get`s, and the two closed-window scans that `apps/server/src/server.ts` starts at startup, which still run on the main thread. The kind separates out the `get`s. An event-loop stall line's "began N s after process start" separates startup passes from steady-state reads. That is how the 2.6 s credited to `listWindows` in the #1038 commit was placed at startup, 3.8 s after process start. The closed-window scans run then, and the line cannot tell them from a `listWindows` call at the same moment. In steady state, `listWindows` peaked at 2.3 s.

## Related Issues

- #1013: the Accounts page timeout and the follow-up to move the remaining main-thread reads.
- #1019: the bounded wait and last good result for session totals.
- #709: the Accounts page waited behind the single reader, which led to the interactive lane.
- #711: the Overview page polled every 30 s on a load that could take 116 s, the same pattern on another endpoint.
- #921: no read falls back to the main thread while a reader lane is attached.
- [sqlite-planner-tie-between-low-cardinality-and-account-index.md](sqlite-planner-tie-between-low-cardinality-and-account-index.md): the opposite case, where the plan was wrong and an index choice fixed it.
