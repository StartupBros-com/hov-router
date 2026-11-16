---
title: A full disk took the router down through its runner, and a tmpfs test does not prove ext4
date: 2026-11-16
category: integration-issues
module: full-disk-resilience
problem_type: integration_issue
component: infrastructure
symptoms:
  - "Every client lost the router for 21 minutes on 2026-11-14 after the host's ext4 root filled; it stayed down until someone freed space and ran systemctl reset-failed and start"
  - "Backend exited 1 on `ENOSPC: no space left on device, write` from a log write nothing caught"
  - "Runner logged `mktemp: failed to create directory via template '/tmp/ccflare-control.XXXXXX'`, then `backend transaction held: ENOSPC`, then `restart circuit open; exiting for service supervisor; status=75`"
  - "After a clean stop on a full ext4 disk, starts failed with `SQLITE_IOERR_SHMSIZE` even though the WAL files had been kept"
root_cause: incorrect_assumption
resolution_type: code_fix
severity: high
related_components:
  - database
  - authentication
  - development_workflow
tags:
  - full-disk
  - enospc
  - sqlite-wal
  - start-reserve
  - pending-rotation
  - runner
  - ext4
  - tmpfs
---

# A full disk took the router down through its runner, and a tmpfs test does not prove ext4

## Problem

On 2026-11-14 the host's ext4 root filled and HoV Router stopped serving every client from
23:20Z to 23:41Z. It did not come back when space returned: systemd's start limit had marked
the unit failed, and a person had to free space and start it again (issue #827). The fix is
PRs #837, #838, #839 and #840. This doc keeps the four beliefs the work had to correct, and the
ext4 reproduction the repo does not carry.

## Symptoms

- The backend exited 1 on an uncaught `ENOSPC ... write` from the log file stream, twice in
  three minutes.
- The runner then could not start a replacement. `mktemp` could not make its control directory
  under `/tmp`, the ownership record write failed with `ENOSPC`, and after three failures it
  logged `restart circuit open; exiting for service supervisor; status=75`.
- systemd restarted the runner within its `StartLimitBurst`, then gave up. The unit stayed
  `failed` after space came back.
- On full ext4 images, a router stopped cleanly could not start again: the first open failed
  with `SQLITE_IOERR_SHMSIZE` at the WAL index, even with the `-wal` and `-shm` files kept.

## What Didn't Work

**Treating it as a backend crash.** Making the backend survive a full disk (a log sink that
fails soft, a backstop for uncaught storage-full errors, a heartbeat that tolerates `ENOSPC` in
warn mode) kept it serving: 40 of 40 requests while full. The outage, though, was the runner
giving up. A backend that survives does not help once the runner has exited 75 three times, and
nothing on the runner's path was allowed to fail for lack of space.

**Keeping SQLite's WAL files on close so a start needs no new blocks.** The first connection to
open a WAL database truncates the `-shm` index and writes it again, so a start releases blocks
and must take them back. On a 64 MB tmpfs that always worked. On 128 MB ext4 images it failed in
almost every measured start (`SQLITE_IOERR_SHMSIZE`). A probe that repeated SQLite's truncate
and page writes on a full ext4 filesystem failed at the seventh 4 KiB page, with the file in six
extents. The rebuild can need a block more than the truncate released. Keeping the files helps,
but guarantees nothing; `packages/database/src/persistent-wal.ts:19` now says so.

**Padding the WAL index from outside the router.** A margin appended to the `-shm` file before
the fill carried starts on ext4, but a router cannot do it to its own index. Closing any
descriptor on that file drops every POSIX lock the process holds on it, and the write races
SQLite growing the index. The scenario keeps it as `--pad-index-bytes`, for measurement only.

**Trusting a temp-file-and-rename store for credentials.** A rotated OAuth refresh token whose
database write fails was saved to an encrypted `.wal` file per account, written to a temp file
and renamed into place. That needs a new block for every save, so on a full disk the only copy
of the new token lived in memory and was lost at the next restart. The 11-14 outage lost none
because no refresh happened to fall in its window.

**Putting the router's state on its own preallocated filesystem.** Rehearsed on scratch loop
images, a fully written image kept working with the outer disk at zero available blocks. A trim
inside it (`fstrim`, or a default `mkfs.ext4`, which discards) handed its blocks back to the
outer disk. Once another writer took them, a write into the image failed with an I/O error and
`e2fsck` reported damage. That fails worse than the full disk it was meant to prevent, so it was
dropped. Letting the service write into ext4's root reserve was dropped too: another root-owned
writer on the host shares that reserve.

## Solution

One invariant: **serving and starting never need a successful disk write.** Each write on
those paths either has nothing to lose, writes in place over blocks it already owns, or waits.

- **Backend (#837, #838).** The log file sink drops lines it cannot write and counts them.
  Nothing in `LogFileWriter` throws (`packages/logger/src/file-writer.ts:106`). A process-level
  backstop survives uncaught errors that say the disk is full and exits 1 for anything else
  (`apps/server/src/storage-full-backstop.ts:64`). "Full" means `ENOSPC`, `EDQUOT` or
  `SQLITE_FULL` (`packages/core/src/storage-full.ts:1`). I/O errors are left out on purpose,
  because a failing device raises them on a disk with room.
- **Start reserve (#837).** The server keeps `better-ccflare.db.start-reserve`, 64 KiB of
  written bytes beside the database (`packages/database/src/start-reserve.ts:16`). When the
  start's open fails for lack of space, it removes that file and opens once more, doing nothing
  in between. Whatever runs there gives another writer time to take the blocks
  (`start-reserve.ts:121`). A check every 30 seconds writes the reserve back once space returns
  (`apps/server/src/start-reserve-keeper.ts:16`). CLI commands never spend it. One reserve
  covers one start.
- **Credential slots (#837).** Each account that rotates its refresh token (`anthropic`,
  `claude-oauth`, `codex`, `xai`) gets one fixed-size slot file, written out in full while there
  is space and overwritten in place after that. The file holds two records and a save writes
  the one that is not current, so a cut-short write leaves the previous record readable
  (`packages/proxy/src/handlers/pending-rotation-slots.ts:28-44`). An account with no slot and
  no space has its refresh refused before the provider is called, so no rotation can exist that
  nothing can store. The refusal is never terminal and pauses nothing
  (`packages/proxy/src/handlers/token-manager.ts:145-150`).
- **Runner (#839, #840).** The control directory lives under systemd's
  `RuntimeDirectory=ccflare-stack`, on `/run`, not on the disk. Ownership and listener records
  are overwritten in place when a new file cannot be made. A start that fails for lack of space
  (the backend exits 28, the errno of `ENOSPC`, `apps/server/src/failed-start.ts:14`) is waited
  out instead of counted toward the restart circuit (`scripts/run-ccflare-stack.sh:1285-1293`).
  A stop that lands mid-start no longer leaves an ownership record at `spawning` that holds
  every later start.

`/health` reports the state in `runtime.storage.fullDisk` (`docs/api-http.md`, "Full-disk
state"). The runner's wait is in `docs/systemd.md`, "Restart Policy Best Practices".

## Why This Works

The 11-14 outage ended because the runner stopped trying, not because the backend could not
run. Waiting out an out-of-space start keeps systemd's start limit out of it, so the unit
recovers by itself once space returns. Exiting would have left it `failed` until someone ran
`systemctl reset-failed`.

Overwriting in place needs no new block, which is what the slot store and the runner records
rely on. That holds on filesystems that overwrite a file's blocks where they are: measured on
ext4 and tmpfs. Copy-on-write filesystems (btrfs, ZFS) allocate on every write, so a save can
still fail there. The slot store's header says so.

The start reserve works because it is a file the router itself releases, at the moment of the
failed open, with nothing between the release and the retry. A margin released by another
process, or by the router with a refill running, lost the blocks before the open could use them
in every measured run.

## Prevention

- **Run full-disk changes on ext4 as well as tmpfs.** CI runs `apps/server/src/disk-full.test.ts`
  on a 64 MB tmpfs in a private mount namespace (`disk-full.test.ts:26`), from source and against
  the compiled binary. On tmpfs a start never needed the reserve, so CI does not exercise the
  reserve's release. Its retry path is covered by unit tests with an injected open
  (`packages/database/src/__tests__/start-reserve.test.ts`). Before changing anything on the
  start path, the WAL handling or the reserve, repeat the measurement on ext4:

  ```bash
  # Scratch only: a 128 MB ext4 image through a loop device. Needs sudo for mount.
  truncate -s 128M /tmp/dfs/ext4.img
  mkfs.ext4 -q -F -m 0 /tmp/dfs/ext4.img        # repeat with -m 5 for a root reserve
  sudo mount -o loop /tmp/dfs/ext4.img /tmp/dfs/mnt
  sudo chown "$(id -u):$(id -g)" /tmp/dfs/mnt
  bun run apps/server/src/disk-full-scenario.ts --dir /tmp/dfs/mnt \
    --restart-loops 10 --deadline-ms 600000 > report.json
  sudo umount /tmp/dfs/mnt
  ```

  The scenario fills the mount to zero free blocks and refills it every 200 ms. `--pressure spin`
  adds a second process that retries a 4 KiB append, so a block the router releases can be
  taken. Give it a pause (`--spin-pause-us 1000`): with none, no start survives, because SQLite
  releases and retakes the index pages at every open. Check `failures` in the report and each
  restart's `healthy`. The runner
  has its own driver (`scripts/__tests__/run-ccflare-stack-full-disk-driver.ts`), and the
  credential slots have `apps/server/src/disk-full-slot-scenario.ts`. Both take the same mount.
  Both scenarios refuse a directory that is not a small dedicated mount, because the fill would
  otherwise fill the host's disk (`apps/server/src/disk-full-support.ts:32`).
- **Compare against a control.** Results differed by image: without the reserve, one 0%-reserve
  image failed 10 of 10 starts and one 5%-reserve image passed 8 of 8. Run each case with and
  without the change on both images before reading a pass as proof.
- **Never write a new file on a path that must work when the disk is full.** A temp file plus
  rename, `mktemp`, a new log file and a new SQLite connection's index all need blocks. Write
  over a file made while there was space, put it on `/run`, or wait for space.
- **Leave the two files alone.** `better-ccflare.db.start-reserve` and
  `pending-rotations/*.slot` look like junk to a disk cleanup. Deleting the reserve costs the
  next full-disk start its margin. A slot can hold the only copy of a rotated refresh token, and
  deleting it then costs that account its sign-in. `docs/troubleshooting.md` names both under
  "Disk Full".

What stays a mitigation: one reserve covers one start, so a second start on a disk that stayed
full can fail, and the runner then waits. A runner killed with `SIGKILL` while starting a
backend can still leave the `spawning` hold.

## Related Issues

- Issue #827 and PRs #837, #838, #839, #840.
- [config-preservation-requires-persisted-oauth-recovery-key.md](config-preservation-requires-persisted-oauth-recovery-key.md):
  the slot store derives its key from the same local-control secret, so that secret must still
  persist.
- [backend-only-deploy-keeps-the-runners-environment.md](../workflow-issues/backend-only-deploy-keeps-the-runners-environment.md):
  why a runner or drop-in change, like #839 and #840, needs a full restart.
- [read-event-loop-stall-host-fields-before-blaming-sql.md](../performance-issues/read-event-loop-stall-host-fields-before-blaming-sql.md):
  the same host, where other workloads fill the disk and memory the router runs on.
