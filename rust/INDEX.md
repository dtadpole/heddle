---
title: Rust port
version: 0.9.5
description: The Cargo workspace of the Rust port of Heddle — what it holds, where it builds and runs, and the per-part status.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-22, asking to build or port Heddle with Rust
  - source: owner statement in the same session, suggesting a Linux devserver as the build environment and an SSH forward to reach its UI
  - source: measurement on the owner's Mac, 2026-10-22, recorded in status.md
---

# `rust`

The Rust port as one Cargo workspace; what completes it is [`ULTIMATE_GOAL.md`](ULTIMATE_GOAL.md). A source
folder, not a type folder. `target/` is cargo's output and is ignored.

| Path | What it is |
|---|---|
| [`ULTIMATE_GOAL.md`](ULTIMATE_GOAL.md) | what completes the port |
| [`Cargo.toml`](Cargo.toml) | the workspace: edition 2024, shared dependency versions, `unsafe_code` forbidden |
| [`crates/`](crates/INDEX.md) | one folder per crate |
| [`building.md`](building.md) | where it builds and runs: the owner's Mac, one worktree per team member, shared build slots |
| [`status.md`](status.md) | the per-part status, from the latest verifier run against the binary, with its command |
| [`status-notes.md`](status-notes.md) | the checks behind it: the D-048 rule, intermittent and fixed checks, the seam |

## Status

On `main` at `0199453`, through the binary: 117 backend checks, **113 pass, 0 fail**, 4 unjudged (they need a real
endpoint). Parts 0 and 2 to 10 are met; part 1 passes its six local checks. Every part, the command and the
failures' owners are in [`status.md`](status.md).

## Read next

[`crates/heddle/`](crates/heddle/INDEX.md) for the binary; [`../_verifiers_/INDEX.md`](../_verifiers_/INDEX.md)
for how a part is decided.
