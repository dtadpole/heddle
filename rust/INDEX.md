---
title: Rust port
version: 0.1.0
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

**Not on the owner's Mac.** Measured 2026-10-22: its binary-authorization policy kills every binary built
there on exec (exit 137), a one-line C program as much as Rust; a packaged `cargo` still checks and lints. Getting
around the policy is not an option. The port is developed on **Linux build hosts over SSH**, whose aliases are
machine configuration (`HEDDLE_BUILD_HOST`), never committed.

**One worktree per team member**, made by [`_tools_/build-host`](../_tools_/build-host/INDEX.md): `~/heddle--<seat>`
on branch `hd/<seat>`, where its owner writes its crates **and their unit tests** and runs them; `~/heddle--int`,
where an integrator merges the branches and runs every verifier through `HEDDLE_BIN`; `~/heddle-live`, the
deployment, whose page the Mac reaches at `localhost:8081` through an SSH forward. One crate is one owner's write
scope, so parallel work never shares a file; [`rust-toolchain.toml`](rust-toolchain.toml) pins the compiler.

## Status

| Part | Status | Evidence |
|---|---|---|
| toolchain, workspace, `HEDDLE_BIN` seam | in place | 2026-10-22: fmt and clippy clean; the seam's unit test passes |
| 0–11 | not started | the binary answers `--help` and exits 2 otherwise |

## Read next

[`crates/heddle/`](crates/heddle/INDEX.md) for the binary; [`../_verifiers_/INDEX.md`](../_verifiers_/INDEX.md)
for how a part is decided.
