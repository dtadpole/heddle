---
title: Local build slots
created: 2026-10-24T05:01:03Z
modified: 2026-10-31T04:20:00Z
level: L2
version: 1.3.0
description: What a build slot guarantees on the shared Mac, from the job cap and small targets to dead-owner reclaim and the bounded wait, and where the runner stops.
status: unverified
grounded_in:
  - source: the local-build INDEX.md version 1.2.0 this was split from
---

# Build slots

What a build slot guarantees to the cargo command inside it, and what the runner leaves alone.

## What a slot guarantees

- **At most three commands at once**, each with **three cargo jobs** (`-j 3`). A caller that passes its own
  `-j` keeps it; the job cap is the default, not a ceiling on a commander who knows better.
- **Small targets.** `CARGO_PROFILE_DEV_DEBUG=0`, `CARGO_PROFILE_RELEASE_DEBUG=0` and `CARGO_INCREMENTAL=0`
  keep every worktree's `target/` near a gigabyte instead of several.
- **A slot is released when the command ends**, normally or by a signal. The runner starts cargo as a child,
  forwards `INT`, `TERM` and `HUP` to it and waits for it, so the slot is never freed while cargo still builds,
  and only removes the directory while it still names this process as its owner.
- **A killed owner does not block the queue.** A slot holds `<pid> <epoch> <cargo pid> <cwd>`; a slot is dead
  when both pids are gone. Every command sweeps dead slots before it takes one, so a build whose shell was
  killed is reclaimed on the next run (its cargo, if it survived, keeps the slot until it exits). A slot whose
  stamp is more than an hour old is reclaimed when no slot is free.
- **First come, first served.** Waiting runs hold tickets and are served in arrival order, not by whoever polls
  first; the coordinator can put one waiter first ([queue.md](queue.md)).
- **A bounded wait.** Thirty minutes by default (`LOCAL_BUILD_WAIT_SECONDS`), then the run exits with a message
  and the no-free-slot code (see [status-and-exit-codes.md](status-and-exit-codes.md)), so a seat reports back
  instead of hanging.

## Bounds

`run` starts `cargo`, or after `--ts` the given command ([ts-slots.md](ts-slots.md)), and nothing else: no `cd` and no `npm`. Its one use of `git` is to list a tree's Rust
sources when several trees share a `CARGO_TARGET_DIR` ([shared-target.md](shared-target.md)). The three slots and the job cap are
defaults for the whole Mac, not reservation of a particular core; see [capacity.md](capacity.md) for the
coordinator's cap file.
