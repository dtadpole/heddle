---
title: The heddle-session crate
version: 0.1.0
description: The Rust port crate for the append-only session log, its store layouts, transcripts, definitions and the session tree.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
---

# `rust/crates/heddle-session`

The Rust port of the append-only session log, its store layouts, transcripts, definitions and the session tree.

| | |
|---|---|
| Ported from | `src/session/` |
| Judged by | `_verifiers_/70-workspaces-sessions`, through the `heddle` binary |
| Sources | [`src/`](src/INDEX.md) |

Its public API lands first, so the crates that depend on it can build against it while it is implemented.

## Read next

[`../INDEX.md`](../INDEX.md) for the other crates; [`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the parts.
