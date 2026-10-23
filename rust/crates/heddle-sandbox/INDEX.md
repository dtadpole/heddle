---
title: The heddle-sandbox crate
version: 0.1.0
description: The Rust port crate for the permission modes, their enforcement backends, escalation and approvals.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
---

# `rust/crates/heddle-sandbox`

The Rust port of the permission modes, their enforcement backends, escalation and approvals.

| | |
|---|---|
| Ported from | `src/sandbox/`, `src/approvals/` |
| Judged by | `_verifiers_/75-permission-sandbox`, `_verifiers_/80-web-ui` (check-approval), through the `heddle` binary |
| Sources | [`src/`](src/INDEX.md) |

Its public API lands first, so the crates that depend on it can build against it while it is implemented.

## Read next

[`../INDEX.md`](../INDEX.md) for the other crates; [`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the parts.
