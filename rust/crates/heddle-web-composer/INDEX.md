---
title: The heddle-web-composer crate
version: 0.1.0
description: The Rust port crate for the composer routes — runtime context, the context view, the model switcher and the tool catalog.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
---

# `rust/crates/heddle-web-composer`

The Rust port of the composer routes — runtime context, the context view, the model switcher and the tool catalog.

| | |
|---|---|
| Ported from | `src/server/tool-catalog.ts`, the composer routes of src/server/web.ts |
| Judged by | `_verifiers_/80-web-ui` (check-composer, check-context-view, check-runtime-context, check-model-switcher), through the `heddle` binary |
| Sources | [`src/`](src/INDEX.md) |

Its public API lands first, so the crates that depend on it can build against it while it is implemented.

## Read next

[`../INDEX.md`](../INDEX.md) for the other crates; [`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the parts.
