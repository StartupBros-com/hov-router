---
title: "A CI-only timing flake came from the runner image's date, so read the image before ruling out the clock"
date: 2026-11-17
category: workflow-issues
module: stack-runner
problem_type: workflow_issue
component: development_workflow
severity: medium
root_cause: incorrect_assumption
resolution_type: code_fix
applies_when:
  - A test fails only on GitHub CI, and local runs pass even under load
  - A failure starts on pull requests whose diff does not touch the failing code
  - A budget, deadline or window in a shell script ends early or late by up to a second
related_components:
  - testing_framework
tags:
  - ci-flake
  - runner-image
  - ubuntu-latest
  - uutils
  - coreutils
  - date
  - epochrealtime
  - stack-runner
---

# A CI-only timing flake came from the runner image's date, so read the image before ruling out the clock

## Context

On 2026-11-17 two runner tests started failing now and then in the `managed-routing-foundation`
check, and nowhere else (#880):

- `scripts/__tests__/run-ccflare-stack.test.ts`, "exits with a bounded circuit status under a
  service auto invocation": the restart circuit allowed a third start inside its 1,000 ms
  window (`Expected: 2`, `Received: 3`).
- `scripts/__tests__/run-ccflare-stack-full-disk.test.ts`, "is killed once the stop budget is
  spent, on a restart and on a stop": a 5,000 ms stop budget ended at 4,783 ms.

Nothing in this repository had changed. The workflows run on `ubuntu-latest`, and GitHub moved
that label from `ubuntu-24.04` to `ubuntu-26.04` during that night. Of the 43 gate runs that
finished between 2026-11-16 21:00Z and 2026-11-17 21:30Z, the 25 up to 02:42Z ran on
`ubuntu-24.04` and the 18 from 04:16Z ran on `ubuntu-26.04`. None went back. The first two
runs on the new image, both on PR #879, failed on these two tests in turn. The second passed
on a rerun, and the failure was read as an unrelated timing test (session history).

Ubuntu 26.04's `date` is uutils coreutils 0.10.0, as read in the `ubuntu:26.04` container
image. When a format cuts the fraction of a second to a width, as `%3N` does, uutils drops the
nanoseconds' leading zeros before it cuts (uutils/coreutils#15697). GNU date pads first. For
the same instant:

```text
date (GNU coreutils) 9.4:       date -u -d @1763350812.045678901 +%s%3N  ->  1763350812045
date (uutils coreutils) 0.10.0: date -u -d @1763350812.045678901 +%s%3N  ->  1763350812456
```

So a reading taken in a second's first 100 ms comes out high, by up to 990 ms: at
`.009999999` it keeps `999` for a true `009`. The worst readings in two sample runs were
963 ms and 935 ms high. In an `ubuntu:26.04` container, 189 of 2,362 readings of
`date +%s%3N` fell outside a bracket of bash's own clock, 185 of them in a second's first
100 ms. The runner's `epoch_ms` read `date +%s%3N`, and every stop budget and restart window
went through it. The production host (Ubuntu 24.04, GNU date 9.4) and every local run read it
correctly.

## What Didn't Work

The first analysis on #880 ruled out the right causes:

- **The clock**, as "no clock jump", because GitHub's log timestamps agreed with the duration
  bun reported for the test. Both of those clocks are outside the script. The bad readings were
  inside the runner's own `date` calls, which neither can see.
- **The restart window**, as "most likely not" the cause of the circuit failure, on the same
  evidence.
- **Load**, because 19 of 19 local runs passed, 18 of them under full CPU load. A GNU host
  never misreads, so no amount of local load reproduces it.
- **A rerun.** The error hits only readings taken in a second's first tenth, so one run fails
  and the next passes. A green rerun says nothing about the cause (session history: #879's
  failure was rerun green and never traced).

## Guidance

When a timing test fails only on CI, and local runs, loaded or not, cannot reproduce it:

1. **Read the runner image before theorizing.** Each job log's "Set up job" step has a
   "Runner Image" group with an `Image:` line and that image's own `Version:`. The "Runner Image
   Provisioner" group above it carries a different version. Compare the first failing run with
   the last passing one:

   ```bash
   gh run view <run-id> --log | grep -m1 -F 'Image: ubuntu'
   ```

2. **Compare that image's tools with the hosts where the test passes.** For a shell script, at
   least `date` and `bash`, in a container of the same release:

   ```bash
   docker run --rm ubuntu:26.04 bash -c 'date --version | head -1; bash --version | head -1'
   ```

3. **Reproduce in that image, red then green.** For #880 the `ubuntu:26.04` image, with `curl`
   and `iproute2` added, reproduced both failures. The listener-stop test failed 3 of 6 runs
   before the fix and 0 of 6 after. The circuit test failed 1 of 80 before and 0 of 160 after.
4. **Test a script's clock against a second clock in the same process.** Outside timestamps
   agreeing does not clear a script's own clock reads. The "run-ccflare-stack millisecond clock"
   test in `scripts/__tests__/run-ccflare-stack.test.ts` brackets every `epoch_ms` reading
   between two reads of `EPOCHREALTIME` across two seconds.

The fix (PR #881) made `epoch_ms` in `scripts/run-ccflare-stack.sh` read bash's
`EPOCHREALTIME` and keep only its digits, so the locale's separator does not matter.
`scripts/__tests__/date-fraction-width.test.ts` fails on a width-cut fraction (`%3N`, `%-3N`,
`%_6N`) in any tracked shell script or workflow. Bare `%N` reads the same on both dates.

## Why This Matters

`ubuntu-latest` can move under the repository with no commit here, and after this move CI no
longer runs the production host's userland. The `ubuntu:26.04` image has bash 5.3.9 and uutils
date 0.10.0. Production runs Ubuntu 24.04, with bash 5.2.21 and GNU date 9.4. A script can pass
on one and fail on the other, in either direction. The move also took away a failure CI used to
show by chance: bash 5.2 dropping a trap handler, which the runner's EXIT-only cleanup is built
for and which its SIGUSR1 tests still exercise directly. See
[the bash 5.2 learning](../integration-issues/bash-5-2-drops-a-trap-handler-so-runner-cleanup-must-work-from-exit-alone.md).

The gate job in `.github/workflows/managed-routing-postgres.yml` therefore names `ubuntu-24.04`,
the production host's release, instead of `ubuntu-latest`, and
`scripts/__tests__/upstream-review-workflow-security.test.ts` fails if that changes unnoticed.
Move the pin when production moves. The other workflows still use `ubuntu-latest`. None of
them runs the test suite.

Not every CI-only runner flake is the image. The runner flake the day before (exit 2 instead of
143) was that bash 5.2 handler drop, on `ubuntu-24.04`. The guard drain test's `"absent"`
(#882) was a mock response that ended itself 250 ms after its headers and raced a recycle
under load, and local load did reproduce it (PR #886). Reading the image costs one command, and
it rules the image in or out before any theory is built on the rest.

## When to Apply

- A test fails only on CI, and a rerun passes.
- A failure starts on pull requests whose diff does not touch the failing code.
- A shell script's budget, deadline or window misses by up to about a second.
- A workflow's `runs-on` names a moving label such as `ubuntu-latest`.

## Examples

Before PR #881, the runner read its millisecond clock from `date`:

```bash
epoch_ms() {
	date +%s%3N
}
```

After it:

```bash
# EPOCHREALTIME's separator follows the locale, so only its digits are kept:
# microseconds, then milliseconds.
epoch_ms() {
	local us="${EPOCHREALTIME//[![:digit:]]/}"
	printf '%s\n' "$((us / 1000))"
}
```

## Related

- Issue #880 (the two flakes) and PR #881 (the fix and both tests).
- [bash-5-2-drops-a-trap-handler-so-runner-cleanup-must-work-from-exit-alone.md](../integration-issues/bash-5-2-drops-a-trap-handler-so-runner-cleanup-must-work-from-exit-alone.md):
  the runner flake before this one, on `ubuntu-24.04`, with a different cause.
- Issue #882 and PR #886: a CI flake in the same test file whose cause was the test's mock
  upstream, not the image.
