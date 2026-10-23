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
| [`Cargo.toml`](Cargo.toml) | the workspace: edition 2024, `unsafe_code` forbidden, clippy at warn |
| [`crates/`](crates/INDEX.md) | one folder per crate |

## Where it builds and runs

**Not on the owner's Mac.** Measured 2026-10-22: its binary-authorization policy kills every binary built
there on exec (exit 137), a one-line C program as much as Rust; a packaged `cargo` still formats, lints and
builds. Getting around the policy is not an option. The port builds and is judged on a **Linux build host
over SSH**; the host's alias is machine configuration, read from `HEDDLE_BUILD_HOST` and never committed. Its
UI reaches the Mac at `localhost:8081` through a forward added to the existing multiplexed connection:

```bash
ssh -O forward -L 127.0.0.1:8081:127.0.0.1:8082 "$HEDDLE_BUILD_HOST"
# on the host
cargo test --manifest-path rust/Cargo.toml && cargo build --release --manifest-path rust/Cargo.toml
HEDDLE_BIN="$PWD/rust/target/release/heddle" sh _verifiers_/05-config-system/verify.sh
```

## Status

| Part | Status | Evidence |
|---|---|---|
| toolchain, workspace, `HEDDLE_BIN` seam | in place | 2026-10-22: fmt and clippy clean; the seam's unit test passes |
| 0–11 | not started | the binary answers `--help` and exits 2 otherwise |

## Read next

[`crates/heddle/`](crates/heddle/INDEX.md) for the binary; [`../_verifiers_/INDEX.md`](../_verifiers_/INDEX.md)
for how a part is decided.
