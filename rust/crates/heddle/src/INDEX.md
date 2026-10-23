---
title: The heddle binary sources
version: 0.1.0
description: The sources of the Rust port's binary, with their unit tests beside the code.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
---

# `rust/crates/heddle/src`

The sources of the binary. Unit tests live beside the code in `#[cfg(test)]` modules, as Rust does; the
verifiers judge the built binary from outside.

## What belongs in it

| File | What it is |
|---|---|
| [`main.rs`](main.rs) | the entry point: classifies the command line, answers `--help`, and exits 2 for what is not ported |

## Read next

[`../INDEX.md`](../INDEX.md) for the crate.
