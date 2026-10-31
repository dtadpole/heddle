---
title: Local build shared target
created: 2026-10-31T02:30:00Z
modified: 2026-10-31T02:30:00Z
level: L2
version: 1.0.0
description: Why two worktrees that share one CARGO_TARGET_DIR can produce a binary from the wrong tree, and how the slot runner prevents it with a lock, a last-tree stamp and a touch of the sources.
status: unverified
grounded_in:
  - source: developer-one's report of a binary built from the wrong tree in a shared target (2026-10-30)
  - source: the coordinator's disk rule of 2026-10-31, one CARGO_TARGET_DIR per seat
  - source: a two-tree reproduction on this Mac, 2026-10-31 02:10Z
---

# Shared target

A seat with several worktrees builds them all into one `CARGO_TARGET_DIR`, because each worktree's own target
costs about 1.2 GB of a disk shared by every seat.

## The trap

Cargo does not key a workspace crate by its checkout path. When tree B's sources are older than tree A's build
in the same target, cargo finds B fresh: the "build" takes no time, and B's binary is A's code. A
fails-before or passes-after run on that binary proves nothing.

## What `run` does

For a compiling command (`build`, `check`, `test`, `run`, `bench`, `doc`, `clippy`, `rustc`, `install`, `fix`)
with `CARGO_TARGET_DIR` set:

1. **One build at a time per target.** It holds `<target>/.local-build-lock` for the whole command. A second
   tree waits (`waiting for the build in <tree> …`) and gives up after `LOCAL_BUILD_WAIT_SECONDS` with code 75.
   A lock whose shell and cargo are both gone is reclaimed.
2. **A switch rebuilds.** `<target>/.local-build-tree` names the tree that built there last. When it names
   another tree, or nothing, `run` touches this tree's tracked and untracked `*.rs` files (`git ls-files -co
   --exclude-standard`), so cargo rebuilds this tree's crates, and says so:
   `local-build: <target> was last built from <tree>; touched 239 Rust sources in <tree> so cargo rebuilds them`.
   A rebuild from the same tree touches nothing.

Dependencies from crates.io are not touched, so a switch rebuilds only the workspace crates.

## Bounds

- The guard needs a git worktree to find the sources, and only `run` keeps it: a plain `cargo` into the same
  target bypasses both the lock and the stamp.
- `LOCAL_BUILD_TREE_GUARD=0` turns it off; without `CARGO_TARGET_DIR`, each worktree has its own target and
  nothing is needed.
