---
title: Local build
version: 1.0.0
description: Runs a cargo command in one of three build slots on the owner's Mac, so the eighteen seats of the Rust port share ten cores and one disk instead of all building at once.
grounded_in:
  - source: owner statement 2026-10-22 that the team works locally on this Mac, not on the h8 devservers
  - source: rust/INDEX.md, the build environment of the Rust port
---

# `local-build`

This Mac is the build environment of the Rust port: one 10-core, 16 GB machine and a single disk, shared by
eighteen sessions. Every cargo command therefore runs inside a **build slot**.

```bash
_tools_/local-build/run test -p heddle-config     # debug tests in your own worktree
_tools_/local-build/run build --release           # release build, integrators only
_tools_/local-build/run status                    # who holds which slot
```

## What a slot guarantees

- **At most three commands at once**, each with **three cargo jobs** (`-j 3`). A caller that passes its own
  `-j` keeps it; the cap is the default, not a ceiling on a commander who knows better.
- **Small targets.** `CARGO_PROFILE_DEV_DEBUG=0`, `CARGO_PROFILE_RELEASE_DEBUG=0` and `CARGO_INCREMENTAL=0`
  keep every worktree's `target/` near a gigabyte instead of several.
- **No stale locks.** A slot is a directory created with `mkdir`; its owner file carries the PID, the time and
  the working directory. A slot whose process is gone, or whose stamp is an hour old, is reclaimed.
- **A bounded wait.** Fifteen minutes by default (`LOCAL_BUILD_WAIT_SECONDS`), then exit 75 with a message,
  so a seat reports back instead of hanging.

Run it from inside your own worktree: the command inherits the caller's working directory, and a cargo command
started in the wrong tree tests the wrong tree.

## Bounds

`run` starts `cargo`, and nothing else: no `cd`, no `git`, no `npm`. The three slots and the job cap are
defaults for the whole Mac, not reservation of a particular core. When the disk falls below 26 GB free,
integrators remove release artifacts before the next verifier run (working model, D-021).

## Read next

[`../../rust/INDEX.md`](../../rust/INDEX.md) for where the port builds and runs and the per-part status.
