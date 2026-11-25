---
title: A kept compatibility surface needs a found consumer and a tracked removal release
date: 2026-11-25
category: workflow-issues
module: http-api
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - Removing or renaming a route, response field, header, CLI command, config key or environment variable, and deciding whether to keep the old one
  - Writing "for one release", "for this release" or "until the next major release" in a migration note, commit message or issue
  - Closing a work-spec issue whose body defers part of its scope to a later release
  - Publishing a release-please draft that bumps the major version
symptoms:
  - Removed Codex lever fields promised "for one release" from 5.0.0 still shipped in 6.0.0 through 6.4.0
  - A docs PR about install pointers widened that promise from "for this release" to "until the next major release"
  - Routes kept under the removed Insights prefix had no caller outside the bundled dashboard
root_cause: missing_workflow_step
resolution_type: workflow_improvement
related_components:
  - proxy
  - documentation
tags:
  - compatibility-surface
  - deprecation
  - removed-endpoints
  - breaking-change
  - release-deadline
  - consumer-search
  - generic-proxy-fallthrough
  - cache-parity
---

# A kept compatibility surface needs a found consumer and a tracked removal release

## Context

Two removals in the 7.0.0 cycle found compatibility surfaces that had outlived any reader.

**Fields kept past their promise.** #735 retired most of the Codex cache levers: the
continuity gate, session keys, prefix sharding, the settle window, pacing bypass and
explicit breakpoints. WebSocket went in #734. #735's commit message kept
`GET /api/insights/cache-parity` reporting the removed levers at fixed values "for one
release". #735 is not in v4.0.0, so 5.0.0 was the first release to carry them. The
5.0.0 migration note listed the full set, turn state and WebSocket included, under "For
this release". From there:

- #788, the work spec for the 5.0.0 removals, listed `webSocketPercent: 0` and
  `codex_settle_ms: 0` under "Kept for a later release". It was closed the day after #789
  merged, with no follow-up named, so the deferral lived on only in its body. Its parent
  tracker, #749, had a checklist line for every other 5.0.0 keep, but none for these
  fields.
- #796, a docs PR titled "point installs at 5.0.1 and upgrade the 5.0.0 fixture" that
  shipped in 5.1.0, rewrote "For this release" as "Until the next major release".
- 6.0.0, the next major release, shipped the fields, and so did 6.1.0 through 6.4.0.
  Nothing failed, because the fields were inert: fixed numbers no code read.
- #1037 removed them on main, together with `codex_settle_ms` in
  `GET /api/debug/cache-pacing` and `backendCapability.explicitBreakpoint`. That last
  field reported `"not_requested"` in every 5.x and 6.x release and never had a promise
  at all. The removal ships
  in 7.0.0, which is unpublished as of this writing (release PR #995).

**Routes kept for a consumer nobody found.** #1015 removed the Insights page (#1012)
but left its alert and cache-parity routes under `/api/insights`. Before 7.0.0 shipped,
#1027 searched for callers and found only the bundled dashboard, which ships in the same
binary and moves with the routes. So #1027 moved the routes to `/api/alerts` and
`/api/cache-parity`.

The contrast is in #749's own checklist. Each keep with a line there was removed on
schedule:

- The 4.0.0 auto-refresh endpoint and `autoRefreshEnabled`, promised "for one release",
  were removed in 5.0.0 by #789.
- #734's removed-Codex-settings startup warning, kept for 5.0.0, was removed by #792 and
  shipped in 5.0.1.

The auto-refresh promise was worded just as loosely as the lever promise. What differed
was the tracker line.

## Guidance

**Keep an old surface only for a consumer you found, and write the search into the PR.**
#1027 and #788 show the shape. Search:

- this repo, minus the bundled dashboard. The dashboard is never a reason to keep a
  route: `apps/server/src/server.ts` serves it from
  `@better-ccflare/dashboard-web/dist/embedded`, so it ships in the binary and moves in
  the same PR;
- the operator's other repositories, and the host's scripts, units, timers and hooks;
- GitHub code and issue search, and any forks.

Production can't settle the question. The router does not log dashboard request paths
(#1027), so no production query finds a caller or rules one out. If the search finds
nobody, remove or move the surface now. If it finds someone, name them.

**Give every time-boxed keep a tracked removal.**

- Put the removal on a tracker as an open checklist item, as #749's 5.0.0 bundle did, and
  cite that issue from the migration note.
- Name the release by version ("until 6.0.0"), not relative to the current one ("for one
  release", "until the next major release"). A relative deadline moves whenever someone
  edits the sentence, and #796 moved this one in a PR about something else.
- An issue that defers scope ("Kept for a later release") opens or names the follow-up
  before it closes. Otherwise the deferral survives only in a closed issue's body.
- Before publishing a major release, search the open trackers and
  `docs/hov-router-migration.md` for keeps that name this release or still use a
  relative deadline, and remove them first.

**Retiring an `/api` route is not a delete.** An unmatched `/api/*` path falls through to
the inference proxy ([never poll an unknown path](never-poll-an-unknown-path-against-a-local-ccflare.md)).
So a removed or moved route needs two things:

- a 410 entry in `packages/http-api/src/removed-endpoints.ts`, naming its replacement;
- a line in `docs/hov-router-migration.md`.

A removed response field needs no stub. It is still a breaking change, though, so the PR
title takes `!` or a `BREAKING CHANGE:` footer for release-please, as #1037 did.

## Why This Matters

- **An inert field never forces its own removal.** It costs nothing at runtime, so the
  only trigger is someone remembering a sentence. The lever fields outlasted the 6.0.0
  major release for exactly that reason.
- **A kept surface keeps costing after its reader is gone.** The types, docs and tests go
  on describing values that mean nothing. Removing ten fixed snapshot fields took #1037
  twelve files: types, two services, a handler, the router, four test files and three docs.
- **A keep with no found consumer is proof-class inflation.** "So existing clients keep
  working" claims an effect nobody checked. #1027's search showed the `/api/insights`
  keep protected no one.
- **A late removal is a second breaking change.** A reader who saw "until the next major
  release" in 5.1.0 found the fields still there through 6.x, and gets the break in 7.0.0
  instead.

## When to Apply

- Any PR that removes or renames a public surface:
  - an `/api` route or a response field;
  - an `x-better-ccflare-*` header;
  - a CLI command or alias;
  - a config key or environment variable.
- Writing a deprecation sentence in a migration note, commit message or issue.
- Closing a work-spec issue whose body says something stays "for a later release".
- Before publishing a release-please draft that bumps the major version.

This is not about the operational names in `AGENTS.md` ("Names that must NOT be
renamed"). Those keep working until a separately approved migration, and they carry no
release deadline.

## Examples

**Untracked keep (the lever fields):**

```text
#735 commit:  reports the removed levers at fixed values for one release
5.0.0 note:   For this release, GET /api/insights/cache-parity still reports the removed Codex levers ...
#788:         Kept for a later release: ... webSocketPercent: 0 and codex_settle_ms: 0   (closed, no follow-up)
5.1.0 note:   Until the next major release, ...                                          (#796)
6.0.0-6.4.0:  fields still shipped
main:         removed by #1037, ships in 7.0.0
```

**Tracked keep (auto-refresh):**

```text
4.0.0 note:   The endpoint keeps answering for one release ...
#749:         Breaking: 5.0.0 bundle
              - [ ] the auto-refresh no-op endpoint, autoRefreshEnabled, and its warning
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

- [Never poll an unknown HTTP path against a local ccflare](never-poll-an-unknown-path-against-a-local-ccflare.md): why an unmatched `/api/*` path reaches the proxy.
- [Typecheck does not cover test call sites](typecheck-does-not-cover-test-call-sites.md): grep the test call sites when removing a field from a shared type.
- `docs/hov-router-migration.md`: "Removed in 5.0.0" and "Codex lever fields removed".
- Issues #749, #788, #1012; PRs #735, #789, #792, #796, #1015, #1027, #1037.
