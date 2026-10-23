---
title: Rust crates
version: 0.1.0
description: The crates of the Rust port, one folder per crate.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
---

# `rust/crates`

The crates of the Rust port, one folder each, all members of the workspace in [`../Cargo.toml`](../Cargo.toml).
A part grows into its own crate when it has a seam worth testing alone — the configuration tree, the session
log, a wire shape — and until then lives in the binary.

## What belongs in it

| Crate | What it is |
|---|---|
| [`heddle/`](heddle/INDEX.md) | the `heddle` binary: the command line every verifier runs |

## Read next

[`../INDEX.md`](../INDEX.md) for how the workspace is built and judged.
