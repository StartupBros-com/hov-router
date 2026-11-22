---
title: "An open release PR is re-pushed only when its body changes, so a release-tooling fix can wait a day to reach it"
date: 2026-11-22
category: workflow-issues
module: router-release
problem_type: workflow_issue
component: development_workflow
severity: low
root_cause: incorrect_assumption
applies_when:
  - A release-tooling change (scripts/router-release.ts, release-please-config.json) merged while a release PR was open
  - An open release PR still shows old version files, CHANGELOG or bun.lock after merges to main
  - The coordinator run is green but its Reconcile step logged that the release PR remained the same
  - Deciding whether an open release PR is ready to merge after such a fix
retire_when: "A release-please upgrade changes Manifest.maybeUpdateExistingPullRequest so an open release PR is re-pushed when only its files would change; check that function in the installed release-please's build/src/manifest.js"
tags:
  - release-please
  - release-pr
  - router-release
  - coordinator
  - bun-lock
  - changelog
  - always-update
---

# An open release PR is re-pushed only when its body changes, so a release-tooling fix can wait a day to reach it

## Context

PR #967 changed the release tooling so that a release edits only the CLI version line in `bun.lock`. Before it, a release re-serialized the whole file. It merged while release PR #944 (6.3.0) was open. #944 carried a 5,669-line `bun.lock` rewrite from the old tooling, and the expectation was that the next coordinator run would re-push #944 with the one-line edit.

That run succeeded, but its "Reconcile release pull requests" step logged `PR https://github.com/StartupBros-com/hov-router/pull/944 remained the same`. #944 still carried the rewrite: its `bun.lock` diff read +5,669/−1,074 in `gh pr view 944 --json files` after that run. The later force-push replaced that diff, so it can no longer be read back. The next push to #944 came from the run after #968, a `perf:` commit, and #944's `bun.lock` diff then became +1/−1.

## Guidance

**How release-please decides.** The coordinator's reconcile step (`.github/workflows/router-release.yml`, "Reconcile release pull requests") runs `scripts/router-release.ts reconcile-pr`. That calls release-please's `createPullRequests()` (`scripts/router-release.ts:225`), and release-please is pinned to 17.11.2 in `package.json`. For an open release PR, release-please compares one thing: the body it just generated against the PR's current body (`maybeUpdateExistingPullRequest` in `node_modules/release-please/build/src/manifest.js`).

- **Same body:** it logs "remained the same" and pushes nothing.
- **Different body:** it rebuilds the release branch on main's current head and force-pushes it with fresh version files, CHANGELOG and `bun.lock` (`updatePullRequest` in `node_modules/release-please/build/src/github.js`, `force: true`). #944's re-pushed commit has #968's merge commit as its only parent.

The title and the files are never compared.

**What changes the body.** Two things:

1. **A commit that adds a release-notes line.** That means a type with a section in `release-please-config.json`: `feat`, `fix`, `security`, `refactor` or `perf`, plus the aliases listed in `AGENTS.md`. `chore`, `docs`, `test`, `style`, `ci` and `build` commits add nothing. That includes Renovate's `chore(deps)` updates and most release-tooling fixes.
2. **A new UTC date.** The notes heading ends with the date it was generated, as in #944's `6.3.0 … (2026-11-22)`. release-please passes the changelog writer a version but no date, so conventional-changelog-writer 6.0.1 uses its default, `dateFormat(new Date(), 'yyyy-mm-dd', true)`: the UTC date. #944 was opened on 2026-11-21 UTC and now reads 2026-11-22. It follows that the first coordinator run on a later UTC day re-pushes the PR even when only chores have merged. That is read from the source; no chore-only next-day run has been observed yet.

**What to do after a release-tooling fix merges while a release PR is open:**

- **Expect the old output to stay.** The release PR keeps its old output until the first coordinator run after either change above.
- **Find out what starts a run.** The release-PR reconcile runs only after the Managed Routing Foundation Gate completes on main (`router-release.yml:7-10`), which follows each merge. A manual dispatch does not refresh the PR: the `pull-requests` job runs only on `workflow_run` (`router-release.yml:73`), and the dispatch inputs exist for draft retries.
- **Check whether a run refreshed the PR.** Read its Reconcile step log, where "remained the same" means nothing was pushed. Then read the PR's files: `gh pr view <N> --repo StartupBros-com/hov-router --json files`.
- **Wait for the fix before merging.** Merge the release PR only once its files show the fix. Merging earlier puts the old output in the release commit.
- **Same-day refresh, untested.** Read from the source and not tried here: editing the release PR's body by hand makes the next run see a difference and re-push the files, replacing your edit.

**Rejected: `always-update`.** Setting `"always-update": true` in `release-please-config.json` turns off the body check (`manifest.js` maps it to `alwaysUpdate`), so every coordinator run would re-push the release PR. That costs a fresh run of every check on the PR after every merge to main: each re-push builds the branch on a new main head, so the PR gets a new head commit. #944's re-push at 06:37 UTC started `prepare`, `managed-routing-foundation`, CodeQL and both Analyze jobs again.

The default costs little now. Since #967 a release changes one line of `bun.lock`. By the date rule, the staleness also ends at the first coordinator run on the next UTC day.

## Why This Matters

The coordinator run is green, and the skip shows only as one line in the Reconcile step's log. An unchanged release PR therefore reads as a fix that failed or a broken coordinator, and either leads to debugging tooling that works.

The other cost is merging the release PR before the refresh. For #967 that would have shipped the full-file `bun.lock` rewrite the fix was written to stop. The next Renovate lockfile PR would then have rewritten the file back to Bun's compact layout.

## When to Apply

- Any change to how a release builds its files (the RouterNode updaters in `scripts/router-release.ts`, `release-please-config.json`), merged while a release PR is open.
- A release PR that looks out of date with main after chore-only merges on the same UTC day.
- Before merging a release PR whose tooling changed since its last push.

## Examples

Release PR #944 (6.3.0), 2026-11-22:

| Coordinator run after | Adds a release-notes line? | Same UTC day as #944's last push? | #944 afterwards |
|---|---|---|---|
| #967, `chore(release)` | no | yes | "remained the same"; `bun.lock` still +5,669/−1,074 |
| #968, `perf(database)` | yes | yes | re-pushed at 06:37 UTC; `bun.lock` +1/−1 |

The `bun.lock` edit itself is covered by the test "release version bump changes only the CLI version line in bun.lock" in `scripts/__tests__/router-release.test.ts`. This doc covers only when that edit reaches an open release PR.

## Related

- `docs/hov-router-releases.md`, "Squash commits release-please can parse". This is a different silent gap in a release PR: release-please drops a commit it cannot parse.
- `docs/hov-router-releases.md`, "Flow". This describes the coordinator run that reconciles release PRs.
- #910 (closed): the Dependabot and Renovate rollout, the source of the routine `chore(deps)` merges that leave a release PR untouched.
