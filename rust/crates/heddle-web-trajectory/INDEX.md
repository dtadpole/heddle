---
title: The heddle-web-trajectory crate
version: 0.1.0
description: The Rust port crate for the trajectory view routes, the ledger and log download.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
---

# `rust/crates/heddle-web-trajectory`

The Rust port of the trajectory view routes, the ledger and log download.

| | |
|---|---|
| Ported from | `src/server/ledger.ts`, `src/server/log-download.ts`, `src/server/tool-inspector.ts` |
| Judged by | `_verifiers_/85-trajectory-view`, `_verifiers_/80-web-ui` (check-trajectory-view), through the `heddle` binary |
| Sources | [`src/`](src/INDEX.md) |

Its public API lands first, so the crates that depend on it can build against it while it is implemented.

## Read next

[`../INDEX.md`](../INDEX.md) for the other crates; [`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the parts.
