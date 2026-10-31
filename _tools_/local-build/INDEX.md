---
title: Local build
version: 1.9.0
description: Runs a cargo command in one of three build slots on the owner's Mac, so the eighteen seats of the Rust port share ten cores and one disk instead of all building at once, and queues the seats fairly for the one browser slot.
grounded_in:
  - source: owner statement 2026-10-22 that the team works locally on this Mac, not on the h8 devservers
  - source: rust/INDEX.md, the build environment of the Rust port
created: 2026-10-23T03:10:31Z
modified: 2026-10-31T04:20:00Z
---

# `local-build`

This Mac is the build environment of the Rust port: one 10-core, 16 GB machine and a single disk, shared by
eighteen sessions. Every cargo command therefore runs inside a **build slot**.

This folder holds the slot runner `run`, its suites in [`_tests_/`](_tests_/INDEX.md), and the articles
below.

## Use

Run it from inside your own worktree: the command inherits the caller's working directory, and a cargo command
started in the wrong tree tests the wrong tree.

```bash
_tools_/local-build/run test --manifest-path rust/Cargo.toml -p heddle-config  # debug tests
_tools_/local-build/run build --release --manifest-path rust/Cargo.toml      # release, integrators only
_tools_/local-build/run status                                               # who holds which slot, and the queue
_tools_/local-build/run --ts -- npm test                                     # a TypeScript test run
```

Waiting runs are served **first come, first served** from a ticket queue, not by whoever polls first. The
coordinator can put one waiter first, once, with `echo <seat> > ~/.hd-build-slots/slot.next`. [queue.md](queue.md)
has the rules.

A TypeScript test run takes a **ts slot**: two at once on the Mac, apart from the cargo slots, and each run's
node tests four files at a time. [ts-slots.md](ts-slots.md) has the rules and the coordinator's `ts-cap`.

## Shared target

A seat's worktrees share one `CARGO_TARGET_DIR`. For a compiling command into it, `run` builds one tree at a
time and, when another tree built there last, touches this tree's Rust sources first, so its binary is never
the other tree's code. [shared-target.md](shared-target.md) has the trap and the rules.

## Browser slot

Every browser gate holds a browser slot: `browser-cap` sets how many, and can reserve one for integrators.
Take one through the queue, not with a bare mkdir:

```bash
_tools_/local-build/browser-slot take --seat <key> --purpose "ui gate"   # exit 75: queued, run it again
_tools_/local-build/browser-slot release --seat <key>
_tools_/local-build/browser-slot run --seat <key> -- <gate command>      # take, run, always release
_tools_/local-build/browser-slot status                                  # slots, holders, memory, next, queue
```

[browser-slot.md](browser-slot.md) has the rules, including the coordinator's `browser.next`, stale holders
and the hand-made lock during the switch.

## TMPDIR sweep

After a gate, run `_tools_/local-build/tmp-sweep` (`--dry-run` to list). It removes `heddle-*`,
`hd-*-browser-*`, `scoped_dir*` and `com.google.Chrome*` entries older than two hours from the user TMPDIR,
but never one a running process names. It also reports the npm and uv cache sizes, and never removes them.
[tmp-sweep.md](tmp-sweep.md) has the details.

## Build output sweep

After each successful build, `run` removes the superseded heddle artifacts in `target/*/deps`: a newer one with
the same name exists, and the old one is over an hour old. `_tools_/local-build/deps-sweep --all` sweeps every
worktree. [deps-sweep.md](deps-sweep.md) has the details.

## Tests

```bash
node --test _tools_/local-build/_tests_/slot-runner/unit.test.mjs
node --test _tools_/local-build/_tests_/browser-slot/unit.test.mjs
node --test _tools_/local-build/_tests_/tmp-sweep/unit.test.mjs
node --test _tools_/local-build/_tests_/deps-sweep/unit.test.mjs
```

Last run 2026-10-30 20:45 PDT, on hd/tool-developer on main aea6bb9a: `node --test _tools_/local-build/_tests_/slot-runner/unit.test.mjs`, 24 passed, 0 failed.

The suite runs the script against a temporary slot root and a fake cargo: no real slot, no real build. It
judges slot release, the exit status, the job cap, six concurrent callers held until released (so a full set of slots is proven, not timed), a killed owner, an old stamp, a live
owner, an ownerless directory, the ownership guard, both owner-file formats, the usage errors, the queue (arrival order over polling speed, a live waiter ahead, dropped and passed-over waiters, the `.next` turn, the status listing, a signal while waiting), that a held caller exits once its test is gone, the ts class (its own pool of two, `ts-cap`, the node shim's `--test-concurrency`, no `-j`, a missing command), and the shared target: the touch on a switch of tree and none on a rebuild, one build at a time, the lock's cargo pid, and a dead or live lock.

## Read next

- [slots.md](slots.md): what a slot guarantees, and its bounds.
- [queue.md](queue.md): the first-come-first-served queue, the 60 s head bypass and the `.next` turn.
- [ts-slots.md](ts-slots.md): TypeScript test runs, their pool of two and the node test concurrency.
- [shared-target.md](shared-target.md): worktrees sharing one target, the wrong-tree trap and the guard.
- [browser-slot.md](browser-slot.md): the browser slot queue, its priority turn and stale-holder rule.
- [tmp-sweep.md](tmp-sweep.md): what the TMPDIR sweep removes and keeps.
- [deps-sweep.md](deps-sweep.md): the build output sweep after each build.
- [status-and-exit-codes.md](status-and-exit-codes.md): the `status` report and every exit code.
- [capacity.md](capacity.md): the coordinator's cap file, the machine report and the disk line.
- [`../../rust/INDEX.md`](../../rust/INDEX.md): where the port builds and runs, and the per-part status.
