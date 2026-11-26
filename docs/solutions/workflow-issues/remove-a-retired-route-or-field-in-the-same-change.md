---
title: Remove a retired route or field in the same change; keep one only for a reader you found and cannot update
date: 2026-11-25
category: workflow-issues
module: http-api
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - Removing a feature whose API routes, response fields, CLI aliases or settings would otherwise stay behind
  - About to keep an old route or field "so existing clients keep working"
  - Writing "for one release", "for this release" or "until the next major release" in a migration note, commit message or issue
symptoms:
  - Removed Codex lever fields reported at fixed values that no code or script read, from 5.0.0 through 6.4.0
  - Routes kept under the removed Insights prefix had no caller outside the bundled dashboard
  - A promise to remove the fields "for one release" was widened in an unrelated docs PR and missed the next major release
root_cause: missing_workflow_step
resolution_type: workflow_improvement
related_components:
  - proxy
  - documentation
tags:
  - compatibility-surface
  - remove-by-default
  - deprecation
  - removed-endpoints
  - breaking-change
  - consumer-search
  - generic-proxy-fallthrough
  - cache-parity
---

# Remove a retired route or field in the same change

## Context

Two removals in the 7.0.0 cycle found old surfaces kept "for compatibility" that served
no one.

**Fields nobody read.** #735 retired most of the Codex cache levers: the continuity
gate, session keys, prefix sharding, the settle window, pacing bypass and explicit
breakpoints. WebSocket went in #734. Rather than drop the response fields, #735 kept
`GET /api/insights/cache-parity` reporting the removed levers at fixed values "for one
release". Nothing outside the endpoint read those numbers:

- The dashboard never referenced them.
- A search of the operator's repositories and scripts for #1037 found no reader.
- The endpoint's own drift report compared each fixed value with an equally fixed
  default.

They described levers that no longer existed. From there:

- The 5.0.0 migration note said "For this release".
- #788 deferred `webSocketPercent: 0` and `codex_settle_ms: 0` "for a later release".
  It was then closed with no follow-up named, and the 5.0.0 tracker (#749) never had a
  line for them.
- #796, a docs PR about install pointers, widened the wording to "until the next major
  release".
- The fields shipped through 6.0.0–6.4.0, and #1037 removed them. 7.0.0 is the first
  release without them.
- `backendCapability.explicitBreakpoint`, reported as `"not_requested"` in every 5.x and
  6.x release, never had a promise at all.

**Routes for a client nobody found.** #1015 removed the Insights page (#1012) but left
its alert and cache-parity routes under `/api/insights` unchanged. #1027 then searched for
callers and found only the bundled dashboard, which ships in the same binary, so the
routes moved to `/api/alerts` and `/api/cache-parity`.

Neither keep had a reader. What each one cost:

- **The lever fields** cost users a second breaking change, two major releases after
  the levers themselves went, and a twelve-file cleanup (#1037).
- **The Insights routes** cost a second breaking PR. It was caught before 7.0.0 shipped,
  so users see one change.

## Guidance

**Default: remove the old route or field in the change that retires the feature.** Update
every reader in the same change:

- **The bundled dashboard.** `apps/server/src/server.ts` serves it from
  `@hov-router/dashboard-web/dist/embedded`, so it ships in the binary and can never
  be out of step with the routes. It is never a reason to keep one.
- **The operator's scripts, units and hooks.** Update them alongside the change.

Mark the PR breaking (`!` or a `BREAKING CHANGE:` footer) and list the removal in
`docs/hov-router-migration.md`.

**A keep is the exception, and it needs a reader a search found that this change cannot
update.** Before keeping anything, search:

- this repo, minus the bundled dashboard;
- the operator's other repositories, and the host's scripts, units, timers and hooks;
- GitHub code and issue search, and any forks.

Write the result into the PR, as #1027 did. Production can't settle the question: the
router does not log dashboard request paths (#1027). Keeping a surface "so existing
clients keep working" with no client found is proof-class inflation. It claims an effect
nobody checked.

**If a keep is truly needed, track its removal.** Do three things:

- Put the removal on an open tracker line that names the release by version, not "for
  one release" or "until the next major release".
- Cite that tracker from the migration note.
- If an issue defers the removal, open or name the follow-up before that issue closes.

The 5.0.0 bundle shows why. The keeps with a #749 line came out on time: the auto-refresh
endpoint with `autoRefreshEnabled` (#789), and #734's startup warning (#792). The one keep
without a line outlived its promise by a major release.

**Two things look like keeps and are not:**

- **A 410 entry in `packages/http-api/src/removed-endpoints.ts`.** It serves nothing old.
  An unmatched `/api/*` path is not refused: it falls through to the inference proxy
  ([never poll an unknown path](never-poll-an-unknown-path-against-a-local-router.md)),
  which can forward it upstream on a real account. So every retired or moved route gets
  an entry naming its replacement. A removed response field needs nothing.
- **The operational names in `AGENTS.md` ("Names that must NOT be renamed").** The
  config directory, the environment variables, the headers and the command names are
  contracts that existing installs' stored configuration and clients depend on. They stay
  until a separately approved migration.

## Why This Matters

- **A keep with no reader never forces its own removal.** Inert fields cost nothing at
  runtime, so removing them depends on someone remembering a sentence. That sentence moved
  twice, and the fields outlasted the release it named.
- **Every kept surface keeps its types, docs and tests alive.** They go on describing
  values that mean nothing. Removing ten fixed snapshot fields later took #1037 twelve
  files.
- **Keeping only delays the break.** Had the fields gone with the levers, users would
  have met one break, in 5.0.0. Instead they met a second one in 7.0.0, after every 5.x
  and 6.x release had reported meaningless numbers.

## When to Apply

- Any PR that retires a feature and so leaves something behind:
  - an `/api` route or a response field;
  - a CLI alias;
  - a config key or environment variable outside the `AGENTS.md` list.
- Reviewing a PR that keeps an old surface: ask which reader it serves, and where the
  search that found that reader is written down.
- Before publishing a major release, search `docs/hov-router-migration.md` and the open
  trackers for keeps that should end with it.

## Examples

**A keep with no reader (the lever fields):**

```text
#735 commit:  reports the removed levers at fixed values for one release
5.0.0 note:   For this release, GET /api/insights/cache-parity still reports the removed Codex levers ...
#788:         Kept for a later release: ... webSocketPercent: 0 and codex_settle_ms: 0   (closed, no follow-up)
5.1.0 note:   Until the next major release, ...                                          (#796)
6.0.0-6.4.0:  fields still shipped
7.0.0:        removed by #1037
```

**The same cycle's tracked keep (auto-refresh):**

```text
4.0.0 note:   The endpoint keeps answering for one release ...
#749:         Breaking: 5.0.0 bundle
              - [ ] the auto-refresh no-op endpoint, `autoRefreshEnabled`, and its warning (already planned)
5.0.0:        removed by #789, item ticked on #749
```

**A moved route answering 410** (`packages/http-api/src/removed-endpoints.ts`, from #1027):

```ts
[
	"/api/insights/cache-parity",
	moved("/api/insights/cache-parity", "GET /api/cache-parity"),
],
```

`moved()` records `removedIn: "7.0.0"` and the replacement, and `removedEndpointResponse`
answers every method on the old path with 410 and `Cache-Control: no-store`.

## Related

- [Never poll an unknown HTTP path against a local router](never-poll-an-unknown-path-against-a-local-router.md): why an unmatched `/api/*` path reaches the proxy.
- [Typecheck does not cover test call sites](typecheck-does-not-cover-test-call-sites.md): grep the test call sites when removing a field from a shared type.
- `docs/hov-router-migration.md`: "Removed in 5.0.0" and "Codex lever fields removed".
- Issues #749, #788, #1012; PRs #735, #789, #792, #796, #1015, #1027, #1037.
