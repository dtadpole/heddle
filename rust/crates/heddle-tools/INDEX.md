---
title: The heddle-tools crate
version: 0.1.0
description: The Rust port crate for the tool registry, the built-in tools, outside tools as processes, and background jobs.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
---

# `rust/crates/heddle-tools`

The Rust port of the tool registry, the built-in tools, outside tools as processes, and background jobs.

| | |
|---|---|
| Ported from | `src/tools/`, `src/plugins/tools.ts` |
| Judged by | `_verifiers_/40-pluggable-tools`, through the `heddle` binary |
| Sources | [`src/`](src/INDEX.md) |

Its public API lands first, so the crates that depend on it can build against it while it is implemented.

## Read next

[`../INDEX.md`](../INDEX.md) for the other crates; [`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the parts.
