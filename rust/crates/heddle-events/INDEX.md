---
title: The heddle-events crate
version: 0.1.0
description: The Rust port crate for the event bus and the named hook points, with the emit, parallel, bail and waterfall modes.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
---

# `rust/crates/heddle-events`

The Rust port of the event bus and the named hook points, with the emit, parallel, bail and waterfall modes.

| | |
|---|---|
| Ported from | `src/events.ts` |
| Judged by | `_verifiers_/60-hooks`, through the `heddle` binary |
| Sources | [`src/`](src/INDEX.md) |

Its public API lands first, so the crates that depend on it can build against it while it is implemented.

## Read next

[`../INDEX.md`](../INDEX.md) for the other crates; [`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the parts.
