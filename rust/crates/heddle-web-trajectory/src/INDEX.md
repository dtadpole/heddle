---
title: The heddle-web-trajectory sources
version: 0.2.0
description: The sources of the heddle-web-trajectory crate, with unit tests beside the code.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
---

# `rust/crates/heddle-web-trajectory/src`

The sources of the crate, with unit tests in `#[cfg(test)]` modules beside the code.

| File | What it is |
|---|---|
| [`lib.rs`](lib.rs) | the crate root, its documentation and re-exports |
| [`ledger.rs`](ledger.rs) | events → the turn-aware ledger (`project_ledger`) |
| [`rows.rs`](rows.rs) | the ledger → the Trajectory table's rows, previews and lanes |
| [`timeline.rs`](timeline.rs) | the ledger → the lane strip's domain and spans |
| [`stats.rs`](stats.rs) | events → the composer dock's figures and the context panel's sections |
| [`usage.rs`](usage.rs) | token usage and its two helpers, until `heddle-llm` publishes them |
| [`inspector.rs`](inspector.rs) | a tool row's inspector blocks |
| [`log_download.rs`](log_download.rs) | the downloaded log's name, header and body |
| [`view.rs`](view.rs) | the `?view=ledger` body |
| [`routes.rs`](routes.rs) | the host trait, `ledger_response` and the `/log` router |

## Read next

[`../INDEX.md`](../INDEX.md) for what the crate ports, what judges it, and its port plan.
