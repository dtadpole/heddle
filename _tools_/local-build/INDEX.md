---
title: Local build
version: 1.3.0
description: Runs a cargo command in one of three build slots on the owner's Mac, so the eighteen seats of the Rust port share ten cores and one disk instead of all building at once.
grounded_in:
  - source: owner statement 2026-10-22 that the team works locally on this Mac, not on the h8 devservers
  - source: rust/INDEX.md, the build environment of the Rust port
created: 2026-10-23T03:10:31Z
modified: 2026-10-24T05:06:33Z
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
_tools_/local-build/run status                                               # who holds which slot
```

## Tests

```bash
node --test _tools_/local-build/_tests_/slot-runner/unit.test.mjs
```

Last run 2026-10-23 22:05 PDT, on hd/tool-developer with main 445ea43 merged: `node --test _tools_/local-build/_tests_/slot-runner/unit.test.mjs`, 16 passed, 0 failed.

The suite runs the script against a temporary slot root and a fake cargo: no real slot, no real build. It
judges slot release, the exit status, the job cap, six concurrent callers held until released (so a full set of slots is proven, not timed), a killed owner, an old stamp, a live
owner, an ownerless directory, the ownership guard, both owner-file formats, the usage errors, and that a held caller exits once its test is gone.

## Read next

- [slots.md](slots.md): what a slot guarantees, and its bounds.
- [status-and-exit-codes.md](status-and-exit-codes.md): the `status` report and every exit code.
- [capacity.md](capacity.md): the coordinator's cap file, the machine report and the disk line.
- [`../../rust/INDEX.md`](../../rust/INDEX.md): where the port builds and runs, and the per-part status.
