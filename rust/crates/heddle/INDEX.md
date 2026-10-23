---
title: The heddle binary crate
version: 0.1.0
description: The Rust port's binary — the command line the verifiers run through HEDDLE_BIN.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
---

# `rust/crates/heddle`

The binary every verifier runs when `HEDDLE_BIN` points at `rust/target/release/heddle`. It must take the
TypeScript build's command line (`node dist/cli.js --help` lists it); until a part is ported it says so on
stderr and exits 2, so a verifier run fails honestly rather than passing on an empty answer.

## What belongs in it

| Path | What it is |
|---|---|
| [`Cargo.toml`](Cargo.toml) | the crate manifest, inheriting the workspace's version and lints |
| [`src/`](src/INDEX.md) | the sources and their unit tests |

## Read next

[`../../INDEX.md`](../../INDEX.md) for the build and the status table.
