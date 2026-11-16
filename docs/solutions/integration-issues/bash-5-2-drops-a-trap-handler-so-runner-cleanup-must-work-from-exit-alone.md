---
title: "bash 5.2 can drop a stop's trap handler, so the runner's exit path must be correct from the EXIT trap alone"
date: 2026-11-16
category: integration-issues
module: stack-runner
problem_type: integration_issue
component: infrastructure
symptoms:
  - "Runner tests failed on CI with `Expected: 143, Received: 2` after sending SIGTERM, in 2 of 33 managed-routing-foundation runs"
  - "bash printed `trap: line 2: unexpected EOF while looking for matching` and exited 2 without running the TERM handler"
  - "An exit 2 injected where that happens during a backend start left owner.json at phase spawning, and the next start held with status 70 (recover reason unreaped_or_ambiguous_owner)"
  - "A runner sent its deploy listener one TERM, then waited on it for good; the test timed out with `the runner was not held in owner-spawning in 20000 ms`"
root_cause: incorrect_assumption
resolution_type: code_fix
severity: high
framework_version: "bash 5.2.21"
related_components:
  - development_workflow
tags:
  - bash
  - trap
  - signals
  - exit-trap
  - runner
  - ownership-record
  - bounded-wait
---

# bash 5.2 can drop a stop's trap handler, so the runner's exit path must be correct from the EXIT trap alone

## Problem

`scripts/run-ccflare-stack.sh` assumed that a trapped TERM always runs its handler. Under bash
5.2.21 (Ubuntu 24.04, which is also CI's `ubuntu-latest`), it does not. A trapped signal that
lands while bash parses a `$(...)` loses its handler. bash prints
``trap: line 2: unexpected EOF while looking for matching `)'``, runs only the EXIT trap and
exits 2. Cleanup that relied on the handler, or on state only the handler sets, was wrong on
that path. In the runner, a stop that landed while a backend was being started could leave the
ownership record at `spawning`, which holds every later start until a person removes it (#859).

A second gap, with a separate cause, was found in the same work: the runner stopped its helpers
with one TERM and a `wait` with no bound, and once waited on a deploy listener for good (#861).
The listener is its own process, not a shell parsing a substitution. Why its TERM did not end
it was never established. PR #865 fixed both. The lesson is that a runner's exit path must be
correct whichever handler ran, and must end.

## Symptoms

- On CI, 2 of 33 `managed-routing-foundation` runs failed with `Expected: 143`,
  `Received: 2` after the test sent SIGTERM. In a local loop with a bash trace, 4 of 149 rounds
  failed the same way, and in each trace only the EXIT trap ran.
- On a shell shaped like the runner (`set -Eeuo pipefail`, `trap cleanup EXIT`,
  `trap terminate TERM`), signalled at a random moment while it looped on the body shown.
  The SIGTERM row was measured 6 of 500 when #859 was filed and 8 of 500 on a re-run for this
  doc. The other rows were all re-run for this doc:

  | Loop body | Signal | Handler lost, exit 2 |
  |---|---|---|
  | `x="$(/bin/echo hi)"` | SIGTERM | 8 of 500 |
  | `x="$(/bin/echo hi)"` | SIGUSR1, trapped | 6 of 500 |
  | `x="$(sleep 0.05; /bin/echo hi)"` | SIGTERM | 0 of 300 |
  | ``x=`/bin/echo hi` `` | SIGTERM | 0 of 300 |
  | `sleep 0.05` | SIGTERM | 0 of 300 |

  The window is the moment bash parses the substitution, not the life of the command inside it.
  At a rate near 1.5%, 0 of 300 does not show that backticks are safe.
- The #859 reproduction used a scratch copy of the runner with an injected `exit 2` at the
  `log` in the held start section, whose `$(date -Is)` is where bash can drop the handler. It
  left `owner.json` at `{"phase":"spawning"}`, and `recover` answered
  `{"action":"hold","reason":"unreaped_or_ambiguous_owner"}`. The next runner exited 70.
- The #861 trace has the runner's last traced line as `wait 1270849` on the listener. It sent
  that listener TERM 3.5 ms after starting it, before the listener's first line ran.

## What Didn't Work

**Changing the stop signal.** A trapped SIGUSR1 loses its handler at about the same rate as
SIGTERM, so picking another signal moves nothing.

**Fixing only the tests (#862).** Stopping the runner only once its deploy listener had started
cured the CI flake, because the test no longer sent its stop at a parse instant. Production
stops land whenever systemd sends them, so the held start section stayed exposed.

**Deciding the close from an empty pid.** The old `close_reaped_owner` returned without closing
anything when no backend pid was noted. An empty pid cannot tell "nothing was spawned" from
"spawned, pid not noted yet", so the first case left the record at `spawning`.

**Treating a record that cannot be read as this runner's `spawning` record.** The first draft
of the fix did, so it would have closed a record it could not read and let a second runner own
the database. The test "leaves a record it cannot read, so the next start is held" caught it.
The transaction module's rule applies here too: only `ENOENT` proves absence
(`scripts/ccflare-deployment-transaction.mjs:42`).

**One TERM, then `wait`.** That wait has no bound. Two probes totalling 1,400 rounds never
lost a TERM, so the cause could not be fixed directly; only the wait could be bounded.

## Solution

The exit path decides from markers set by plain assignments, not from which handler ran, and
every wait in it ends (#865).

- **A spawn marker.** `owner_spawn_begun` (`scripts/run-ccflare-stack.sh:135`) is set just
  before the backend is launched (`:1070`). `close_reaped_owner` (`:458`) reads it:

  ```bash
  close_reaped_owner() {
  	((transaction_enabled && owner_open)) || return 0
  	if ((!owner_spawn_begun)); then
  		close_unstarted_owner
  		return 0
  	fi
  	[[ -n "$owner_open_pid" ]] || return 0
  	# ... owner-reaped with the noted pid and start time
  }
  ```

  `close_unstarted_owner` (`:480`) writes only when `owner_record_spawning` (`:443`) read the
  record and it says `"phase":"spawning"`. A record that is missing, says something else or
  cannot be read is left as it is.
- **The pid is noted in the backend's own command.** `upstream_pid=$! owner_open_pid=$!`
  (`:1085`) is one simple command. bash runs trap handlers between commands, so this narrows
  the moment at which cleanup could stop the backend while the record's close does not know
  which one it was.
- **Bounded helper stops.** `stop_owned_helper` (`:315`) sends TERM and polls with `kill -0`
  every 50 ms (`HELPER_STOP_POLL_S`, `:302`), sending TERM again at each poll. After
  `HELPER_STOP_BUDGET_MS` (5000, `:301`) it logs `did not stop after 5000ms; sending SIGKILL`,
  sends SIGKILL, polls five more times at 0.1 s and goes on either way. It never calls `wait`.
  bash reaps an exited background child by itself (50 of 50 in a probe), so `kill -0` stops
  finding it. The same function stops the deploy listener, the retiring backend's reaper and
  the guard control call.

`scripts/deploy-ccflare.sh` already worked this way: its rollback runs from the EXIT trap
(`trap 'rollback_on_failure $?' EXIT`, `:278`), not from a signal handler.

## Why This Works

The EXIT trap ran on every exit path measured here: a normal exit, a dropped handler, and a
signal the runner does not trap. SIGUSR1 ends the runner through its EXIT trap, which is why the
tests use it to stand in for a dropped handler. Only SIGKILL skips the EXIT trap. A cleanup that
is right from EXIT alone is right on all of those paths. The markers are plain assignments made
in the main flow, so a signal cannot leave one half set. The cleanup then decides from what was
done, not from how the shell is leaving.

One window remains, on purpose. Between the backend's launch (`&`) and the pid note, a backend
may be running that the record does not name. There the record is left at `spawning` and the
next start holds. That is correct. In a scratch copy of the runner used while writing #865, an
`exit 2` injected there left a live backend, and a mutant that ignored the marker closed the
record while that backend still ran, so `recover` answered `start` and would have allowed a
second one.

## Prevention

- **In a bash script with a TERM or INT trap, put the cleanup in the EXIT trap and make it
  correct on its own.** Decide from markers set by plain assignments in the main flow. Do not
  decide from a flag only a signal handler sets, or from a value that is empty in two different
  states. Read an exit status of 2 after a signal as the dropped-handler path, not a script error.
- **Never `wait` without a bound in a stop path.** Poll `kill -0` and escalate to SIGKILL once a
  budget is spent, as `stop_child` (`:237`) does for the backend and the guard.
  `stop_owned_helper` also sends TERM again at each poll, because a helper once outlived its
  first one.
- **Test the EXIT-only path directly.** Send the runner SIGUSR1, which it does not trap, at the
  moment under test. See "closes the record when the runner is ended without its stop handler as
  the record is written" (`scripts/__tests__/run-ccflare-stack-full-disk.test.ts:449`). The
  bounded helper stop is covered by the describe "a deploy listener that does not stop when it is
  told to" (`:567`). Its listeners ignore TERM outright, because the real cause is unknown.
- **Check a new bash before relying on the handler again.** This probe is the measurement above:

  ```bash
  # 143 = the TERM handler ran; 2 = it was dropped and only the EXIT trap ran.
  lost=0
  for ((i = 0; i < 500; i++)); do
  	bash -c 'set -Eeuo pipefail; cleanup() { :; }; terminate() { exit 143; }
  		trap cleanup EXIT; trap terminate TERM
  		while :; do x="$(/bin/echo hi)"; done' 2>>trap-probe.err &
  	pid=$!
  	sleep "0.0$((RANDOM % 9 + 1))"
  	kill -TERM "$pid"
  	wait "$pid"
  	if (($? == 2)); then lost=$((lost + 1)); fi
  done
  echo "bash ${BASH_VERSION}: handler dropped in ${lost} of 500"
  grep -c -F 'unexpected EOF while looking for matching' trap-probe.err
  ```

  A result of 0 on a later bash does not make the EXIT-only design unnecessary. An untrapped
  signal still ends a script through its EXIT trap alone.

## Related Issues

- Issues #859 and #861, fixed by PR #865. The test-side fix for the CI flake is PR #862.
- [full-disk-outage-was-the-runner-giving-up.md](full-disk-outage-was-the-runner-giving-up.md):
  the ownership record, the `spawning` hold and the held start section this fix closes.
- [backend-only-deploy-keeps-the-runners-environment.md](../workflow-issues/backend-only-deploy-keeps-the-runners-environment.md):
  why a runner change like #865 ships only with a full restart.
