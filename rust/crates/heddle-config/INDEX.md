---
title: The heddle-config crate
version: 0.1.0
description: The Rust port crate for the configuration tree — profiles, patch layers, includes, environment references, validation and provenance.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
---

# `rust/crates/heddle-config`

The Rust port of the configuration tree — profiles, patch layers, includes, environment references, validation and provenance.

| | |
|---|---|
| Ported from | `src/config/`, `src/local-config.ts`, `src/paths.ts`, `src/endpoints.ts` |
| Judged by | `_verifiers_/05-config-system`, through the `heddle` binary |
| Sources | [`src/`](src/INDEX.md) |

Its public API lands first, so the crates that depend on it can build against it while it is implemented.

## Read next

[`../INDEX.md`](../INDEX.md) for the other crates; [`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the parts.
