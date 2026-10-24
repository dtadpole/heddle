---
title: Where the Rust port builds and runs
created: 2026-10-24T05:50:00Z
modified: 2026-10-24T05:50:00Z
level: L3
version: 1.0.0
description: The owner's Mac as the build host, one worktree per team member, and the shared build slots.
status: unverified
grounded_in:
  - source: owner statement in the dsh session, 2026-10-22, suggesting a Linux devserver as the build environment
  - source: measurement on the owner's Mac, 2026-10-22 (D-020)
---

# Where it builds and runs

**On the owner's Mac, locally** (D-020, 2026-10-22). The earlier measurement that this Mac kills every binary
it builds on exec (exit 137) did not reproduce: a compiled C probe and this workspace both ran, and
`cargo check --workspace` completed here. Rust 1.99.1 with rustfmt and clippy comes from rustup, pinned by
[`rust-toolchain.toml`](rust-toolchain.toml); there are no devservers in this setup, no SSH and no
`HEDDLE_BUILD_HOST`.

**One worktree per team member**, `~/heddle--<seat>` on branch `hd/<seat>`, where its owner writes its crates
**and their unit tests** and runs them; `~/heddle--int-backend` and `~/heddle--int-ui`, where each integrator merges
its lane's branches and runs every verifier through `HEDDLE_BIN`; `~/heddle-live`, the deployment, whose page the
owner reaches at `http://127.0.0.1:8082/`. One crate is one owner's write scope, so parallel work never shares a
file. Cargo runs in one of three build slots ([`_tools_/local-build`](../_tools_/local-build/INDEX.md)) because the
team shares ten cores and one disk.
