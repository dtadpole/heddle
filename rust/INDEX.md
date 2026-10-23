---
title: Rust port
version: 0.2.0
description: The Cargo workspace of the Rust port of Heddle — what it holds, where it builds and runs, and the per-part status.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-22, asking to build or port Heddle with Rust
  - source: owner statement in the same session, suggesting a Linux devserver as the build environment and an SSH forward to reach its UI
  - source: measurement on the owner's Mac, 2026-10-22, recorded below
---

# `rust`

The Rust port as one Cargo workspace; what completes it is [`ULTIMATE_GOAL.md`](ULTIMATE_GOAL.md). A source
folder, not a type folder. `target/` is cargo's output and is ignored.

| Path | What it is |
|---|---|
| [`ULTIMATE_GOAL.md`](ULTIMATE_GOAL.md) | what completes the port |
| [`Cargo.toml`](Cargo.toml) | the workspace: edition 2024, shared dependency versions, `unsafe_code` forbidden |
| [`crates/`](crates/INDEX.md) | one folder per crate |

## Where it builds and runs

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

## Status

| Part | Status | Evidence |
|---|---|---|
| toolchain, workspace, `HEDDLE_BIN` seam | in place | 2026-10-22: fmt and clippy clean; the seam's unit test passes |
| 0–11 | not started | the binary answers `--help` and exits 2 otherwise |

## Read next

[`crates/heddle/`](crates/heddle/INDEX.md) for the binary; [`../_verifiers_/INDEX.md`](../_verifiers_/INDEX.md)
for how a part is decided.
