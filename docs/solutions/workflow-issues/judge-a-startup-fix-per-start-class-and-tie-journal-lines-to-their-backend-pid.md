---
title: Judge a startup fix from the journal per start class, and tie each line to its backend by PID
date: 2026-11-25
category: workflow-issues
module: deploy-measurement-provenance
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - Judging from the production journal whether a change to backend startup worked
  - Counting how often a startup symptom, such as a slow statement or an event-loop stall, appears per backend start
  - Placing a journal line in a backend's run by its time since the newest start
  - Reading journalctl -u ccflare-stack.service without sudo
symptoms:
  - One quiet start after a deploy is read as evidence that a startup fix works
  - "Counting systemd `Started ccflare-stack.service` lines finds a handful of starts, while the backend logged dozens of `Ready to proxy requests` lines"
  - A main-thread statement logged at shutdown looks like a stall minutes into a run
  - The same journal query returns fewer starts an hour later
root_cause: incorrect_assumption
resolution_type: workflow_improvement
related_components:
  - systemd-deploy
  - observability
tags: [journalctl, start-class, backend-only, handoff, full-restart, supervisor-restart, base-rate, pid-attribution, startup-stall, wal-checkpoint, journal-rotation]
---

# Judge a startup fix from the journal per start class, and tie each line to its backend by PID

## Context

#1046 moved the two closed-window scans that run at backend startup off the main thread. Judging it from the production journal (`journalctl -u ccflare-stack.service`) went wrong twice in one session (#1042). Both mistakes came from treating every backend start, and every line near one, alike.

- **A pooled base rate.** The first count found 3 window-column startup stalls in 30 earlier starts, so one quiet start after the deploy looked like the expected result about 9 times in 10. Split by start class, all 3 stalls were in backend-only handoffs, and no full restart had one. The deploy being judged was a full restart, so its quiet start tested nothing. The correction is on #1042.
- **Placing lines by the newest start.** Five `Slow main-thread SQL: … exec PRAGMA wal_checkpoint(TRUNCATE)` lines, the longest 5016 ms, looked like main-thread work in a running backend. Four of them came 149 to 595 s after the newest `Ready to proxy requests` line. Each one was logged by an outgoing backend as it closed after a handoff, and in those four cases its replacement was already serving.

## Guidance

**Classify every start from the runner's own lines.** Every process in the unit logs under the `run-ccflare-stack.sh[PID]` identifier, with its own PID: the runner, the guard and each backend. A backend start is its `⚡ Ready to proxy requests...` line (`apps/server/src/server.ts`), and the PID on that line is the new backend's. The runner's own lines begin with a `[timestamp]` from `log()` in `scripts/run-ccflare-stack.sh`, and the runner line just before a READY line names the class:

| Runner line before READY | Class | What stays up |
|---|---|---|
| `backend handoff mode=overlap; old_pid=N` (or `mode=drain`) | backend-only handoff, a retained-ingress replacement | the runner and the guard; backend N finishes its accepted work, as a *Quiesced backend* (`CONCEPTS.md`) or drained under `mode=drain`, then exits |
| `runner stop budgets configured; …` under a runner PID not seen before | full restart: the service manager started a new runner | nothing |
| `restarting stack via supervisor; child=…; class=…` | supervisor restart: the same runner restarted the guard and backend | the runner |

systemd's `Started ccflare-stack.service` lines are in the system journal. An unprivileged `journalctl` prints "You are currently not seeing messages from other users and the system" and shows none of them. Even read with sudo, they count only full restarts. The runner's lines classified all 25 starts in the extract below.

**Count the symptom per class, and judge a fix only on the class that showed it.** In the extract from 2026-11-22 21:17Z to 2026-11-26 01:06Z, a window-column startup stall was a `Slow main-thread SQL: … all SELECT id, account_id, window_key` line from the new backend:

| Class | Starts | With a window-column startup stall |
|---|---|---|
| Backend-only handoff | 20 | 3 |
| Full restart | 4 | 0 |
| Supervisor restart | 1 | 0 |

A quiet start in a class that never showed the symptom is no evidence. In the class that did, one quiet start is weak evidence. At 3 in 20, it takes 19 quiet handoffs in a row before chance alone falls under 1 in 20 (0.85^19 ≈ 0.046). Two of the three stalls ended 8 and 9 s after an outgoing backend's slow close checkpoint (1939 ms and 5016 ms). That fits competition for the disk during a handoff, but three cases do not establish it.

**Look for a line the fix changes, not for a quiet start.** A fix that moves a statement to another thread changes the line it logs. Since #1046, a slow startup scan logs as an unsuffixed `Slow off-thread SQL` line instead of `Slow main-thread SQL`. One such line, on a start of any class, shows which thread ran the scan. A scan that finishes under the 250 ms slow-SQL threshold logs nothing at all. Per-thread I/O counters show which thread ran it on any start: [verify-worker-thread-lanes-by-per-thread-syscr.md](verify-worker-thread-lanes-by-per-thread-syscr.md). The keyed `get` lines that begin with the same columns are not the scans: [polled-endpoint-waiting-on-an-unbounded-read-dies-on-a-slow-disk.md](../performance-issues/polled-endpoint-waiting-on-an-unbounded-read-dies-on-a-slow-disk.md).

**Tie each line to the process that logged it, not to the newest start.** The PID in `run-ccflare-stack.sh[PID]` is journald's `_PID` for the line, which `journalctl -o json` shows as a field. During a handoff two backends log at once, and the outgoing one keeps logging until it exits.

- `old_pid=N` on the handoff line names the outgoing backend. The runner's `retiring backend reaped; pid=N` line marks its exit. Four of the five checkpoint lines came 0.04 to 0.13 s before their PID's reaped line. The fifth PID was the `old_pid` of the handoff 133 s earlier.
- Those lines come from `BunSqlAdapter.close()` (`packages/database/src/adapters/bun-sql-adapter.ts`), the only checkpoint the running server issues on its main thread. The periodic checkpoint runs in the incremental-vacuum worker, and the main connection sets `wal_autocheckpoint = 0` (`packages/database/src/database-operations.ts`). A main-thread checkpoint line therefore comes from a backend that is shutting down.
- Search before READY too. Each stall line was logged by the new backend 0.6 to 1.2 s before its own READY line, so a window that starts at READY misses every one. Select a backend's lines by its PID, across its whole lifetime.

**Save one extract and count from it.** The journal rotates. Two reads on one evening, both covering 2026-11-22 onward, found 31 starts and then 24, because the oldest lines were removed between them. By 2026-11-26 01:06Z an unprivileged read began at 2026-11-22 21:17Z. Write the range to a file once and work only from the file:

```bash
journalctl -u ccflare-stack.service --since "2026-11-22 00:00 UTC" -o short-iso-precise --no-pager > extract.log
```

**Name the time zone in every bound.** The host runs at -05:00, and one line can carry two times five hours apart:

- `--since` reads local time unless the value ends in `UTC`.
- journalctl's own timestamp column is local; `--utc` prints UTC.
- The runner's `[…]` prefix is local time with an offset (`date -Is`).
- The backend's `[…]` prefix is UTC, ending in `Z`.

## Why This Matters

#1042 stays open until production shows #1046 working, and whoever checks it next will read the same journal. Pooling the start classes made a start that tested nothing look like a 9-in-10 confirmation. Placing lines by the newest start points at a 5 s main-thread stall in a serving backend that never happened: the work belonged to a backend that had already been replaced and was shutting down. Each mistake ends as a confident, wrong sentence in an issue comment, and that is worse than writing nothing.

## When to Apply

- Before writing that a startup change worked, or did not, from the journal.
- When counting a symptom per start, or setting a threshold from that count.
- When the deploy being judged is a different start class from the starts that showed the symptom. `scripts/deploy-ccflare.sh --check` says which kind a deploy will be: [backend-only-deploy-keeps-the-runners-environment.md](backend-only-deploy-keeps-the-runners-environment.md).

## Examples

To list the start-class markers from a saved extract (this reads only the file):

```bash
rg -n -F -e 'Ready to proxy requests' -e '] backend handoff mode=' -e '] runner stop budgets configured' -e '] restarting stack via supervisor' -e '] retiring backend reaped' extract.log
```

The handoff with the longest checkpoint, on 2026-11-24, with times in UTC and the PID each line carried:

```text
22:35:26  runner  3557599  backend handoff mode=overlap; old_pid=3557958
22:37:39  backend 3557958  Slow main-thread SQL: 5016ms exec PRAGMA wal_checkpoint(TRUNCATE)
22:37:48  backend 2954715  Slow main-thread SQL: 2884ms all SELECT id, account_id, window_key, …
22:37:49  backend 2954715  ⚡ Ready to proxy requests...
```

The checkpoint belongs to 3557958, the backend that was leaving, not to the start a second later. The scan line belongs to 2954715, and it was logged before that backend's READY line.

The first two starts on a build with #1046 were at 2026-11-26 00:01Z and 00:52Z. Production's `/health` read after each gave `git_sha` bc4595b5 and then 5cbe0740, both descended from #1046, with `handoff.pid` equal to the new backend's PID. Both were full restarts. Neither logged a window-column `all` line on the main thread, but neither did the two full restarts in the extract from before the fix, so these two starts test nothing. The check still needs one of three things: a backend-only handoff start, a scan line that logs as off-thread, or the per-thread counters.

## Related

- #1042: the issue that made main-thread reads opt-in. It stays open on the live check for the startup scans, and its comments correct the pooled count.
- #1046: the startup scans moved to the bulk reader.
- [verify-fix-ancestry-before-citing-a-measured-rate.md](verify-fix-ancestry-before-citing-a-measured-rate.md): which build a measured production rate came from. This doc covers which starts and which process.
- [read-event-loop-stall-host-fields-before-blaming-sql.md](../performance-issues/read-event-loop-stall-host-fields-before-blaming-sql.md): the fields on an event-loop stall line, including "began N s after process start".
- [measure-session-remap-cache-cost-from-the-requests-table.md](../observability/measure-session-remap-cache-cost-from-the-requests-table.md): counts starts from a backend line, for the same reason systemd lines undercount.
