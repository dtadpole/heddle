---
title: The heddle-web-trajectory sources
created: 2026-10-23T00:55:27Z
modified: 2026-10-23T05:10:00Z
version: 0.3.1
description: The sources of the heddle-web-trajectory crate, with unit tests beside the code.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
---

# `rust/crates/heddle-web-trajectory/src`

The sources of the crate, with unit tests in `#[cfg(test)]` modules beside the code.

| File | What it is |
|---|---|
| [`lib.rs`](lib.rs) | the crate root, its documentation and re-exports |
| [`js_json.rs`](js_json.rs) | `JSON.stringify` with JavaScript's number formatting, for the text a person reads and the bytes `/log` writes |
| [`ledger.rs`](ledger.rs) | events → the turn-aware ledger (`project_ledger`) |
| [`rows.rs`](rows.rs) | the ledger → the Trajectory table's rows, previews and lanes |
| [`timeline.rs`](timeline.rs) | the ledger → the lane strip's domain and spans |
| [`stats.rs`](stats.rs) | events → the composer dock's figures and the context panel's sections |
| [`usage.rs`](usage.rs) | token usage and its two helpers, until `heddle-llm` publishes them |
| [`inspector.rs`](inspector.rs) | a tool row's inspector blocks |
| [`log_download.rs`](log_download.rs) | the downloaded log's name, header and body |
| [`view.rs`](view.rs) | the `?view=ledger` body |
| [`routes.rs`](routes.rs) | the host trait, `ledger_response`, `log_response` and the `/log` router |
| [`test_support.rs`](test_support.rs) | the in-memory host the route and view tests run against (`#[cfg(test)]` only) |

## Read next

[`../INDEX.md`](../INDEX.md) for the crate's map; [`../API.md`](../API.md) for the public API.
