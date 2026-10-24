---
title: The heddle-context integration tests
created: 2026-10-24T05:14:04Z
modified: 2026-10-24T05:14:04Z
version: 1.0.0
description: The heddle-context crate's integration tests, which hold the port to values and logs the TypeScript build itself produced.
grounded_in:
  - source: src/context/, the TypeScript build these tests compare against, run under Node
---

# `rust/crates/heddle-context/tests`

Unit tests sit beside the code in `src/`. The tests here compare the Rust port with the TypeScript build's own output,
so a value that only looks plausible cannot pass.

## What belongs here

| File | Compares |
|---|---|
| [`typescript-agreement.rs`](typescript-agreement.rs) | prices, budget rounding, the pruned text, the digest's trim rules and rendered instruction baselines, each a value measured from `src/context/` under Node |
| [`engine-agreement.rs`](engine-agreement.rs) | the TypeScript store and engine's record of four compaction scenarios, replayed event for event and byte for byte, from [`fixtures/`](fixtures/INDEX.md) |

A new test here names the TypeScript value or record it reproduces. A test that needs only the crate's own seams
belongs beside the code.

## Read next

[`../INDEX.md`](../INDEX.md) for the crate's API and port plan; [`fixtures/INDEX.md`](fixtures/INDEX.md) for the
recorded oracle.
