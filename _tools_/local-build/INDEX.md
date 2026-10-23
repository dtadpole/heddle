---
title: Local build
version: 1.1.0
description: Runs a cargo command in one of three build slots on the owner's Mac, so the eighteen seats of the Rust port share ten cores and one disk instead of all building at once.
grounded_in:
  - source: owner statement 2026-10-22 that the team works locally on this Mac, not on the h8 devservers
  - source: rust/INDEX.md, the build environment of the Rust port
---

# `local-build`

This Mac is the build environment of the Rust port: one 10-core, 16 GB machine and a single disk, shared by
eighteen sessions. Every cargo command therefore runs inside a **build slot**.

```bash
_tools_/local-build/run test --manifest-path rust/Cargo.toml -p heddle-config  # debug tests
_tools_/local-build/run build --release --manifest-path rust/Cargo.toml      # release, integrators only
_tools_/local-build/run status                                               # who holds which slot
```

## What a slot guarantees

- **At most three commands at once**, each with **three cargo jobs** (`-j 3`). A caller that passes its own
  `-j` keeps it; the cap is the default, not a ceiling on a commander who knows better.
- **Small targets.** `CARGO_PROFILE_DEV_DEBUG=0`, `CARGO_PROFILE_RELEASE_DEBUG=0` and `CARGO_INCREMENTAL=0`
  keep every worktree's `target/` near a gigabyte instead of several.
- **A slot is released when the command ends**, normally or by a signal. The runner starts cargo as a child,
  forwards `INT`, `TERM` and `HUP` to it and waits for it, so the slot is never freed while cargo still builds,
  and only removes the directory while it still names this process as its owner.
- **A killed owner does not block the queue.** A slot holds `<pid> <epoch> <cargo pid> <cwd>`; a slot is dead
  when both pids are gone. Every command sweeps dead slots before it takes one, so a build whose shell was
  killed is reclaimed on the next run (its cargo, if it survived, keeps the slot until it exits). A slot whose
  stamp is more than an hour old is reclaimed when no slot is free.
- **A bounded wait.** Thirty minutes by default (`LOCAL_BUILD_WAIT_SECONDS`), then exit 75 with a message,
  so a seat reports back instead of hanging.

Run it from inside your own worktree: the command inherits the caller's working directory, and a cargo command
started in the wrong tree tests the wrong tree.

## `status`

```text
root: ~/.hd-build-slots
slots: 3  jobs: 3
slot 0: busy pid=3521 cargo=3499 age=151s cwd=~/heddle--developer-six
slot 1: free
slot 2: stale pid=7371 cargo=0 age=3601s cwd=~/heddle--developer-twelve
summary: busy=1 stale=1 free=1
```

`status` exits `0` when every slot is free or live, and `1` when it found a stale or ownerless slot — a
machine-readable "something died here". A run's exit status is cargo's; `64` is a usage error, `75` is no free
slot within the wait, and `127` is cargo not found.

## Bounds

`run` starts `cargo`, and nothing else: no `cd`, no `git`, no `npm`. The three slots and the job cap are
defaults for the whole Mac, not reservation of a particular core. When the disk falls below 26 GB free,
integrators remove release artifacts before the next verifier run (working model, D-021).

## Tests

```bash
node --test _tools_/local-build/_tests_/slot-runner/unit.test.mjs
```

The suite runs the script against a temporary slot root and a fake cargo: no real slot, no real build. It
judges slot release, the exit status, the job cap, six concurrent callers, a killed owner, an old stamp, a live
owner, an ownerless directory, the ownership guard, both owner-file formats and the usage errors.

## Read next

[`../../rust/INDEX.md`](../../rust/INDEX.md) for where the port builds and runs and the per-part status.
