---
title: The heddle-llm crate
version: 0.1.0
description: The Rust port crate for the backend wire shapes, the HTTP client, streamed content and reasoning deltas, model info and usage.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
---

# `rust/crates/heddle-llm`

The Rust port of the backend wire shapes, the HTTP client, streamed content and reasoning deltas, model info and usage.

| | |
|---|---|
| Ported from | `src/llm/`, `src/stream/`, `src/plugins/model.ts` |
| Judged by | `_verifiers_/10-llm-backends`, `_verifiers_/20-streaming`, `_verifiers_/98-model-endpoints`, through the `heddle` binary |
| Sources | [`src/`](src/INDEX.md) |

Its public API lands first, so the crates that depend on it can build against it while it is implemented.

## Read next

[`../INDEX.md`](../INDEX.md) for the other crates; [`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the parts.
