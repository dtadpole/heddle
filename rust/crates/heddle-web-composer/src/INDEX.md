---
title: The heddle-web-composer sources
version: 0.3.0
description: The sources of the heddle-web-composer crate, with unit tests beside the code.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
---

# `rust/crates/heddle-web-composer/src`

The sources of the crate, with unit tests in `#[cfg(test)]` modules beside the code.

| File | What it is |
|---|---|
| [`lib.rs`](lib.rs) | the crate root, its documentation, `ComposerHost` and `router` |
| [`http.rs`](http.rs) | the TypeScript server's answer shapes and body reading, shared with the Trajectory crate |
| [`js.rs`](js.rs) | the JavaScript behaviours the projections reproduce: `Date.parse`/`toISOString`, UTF-16 slicing, `\s`, JSON stringification, `encodeURIComponent`, HTML escaping |
| [`session.rs`](session.rs) | `SessionLookup`, the question every per-session route asks first |
| [`catalog.rs`](catalog.rs) | the tool catalog the Trajectory details pane shows |
| [`status.rs`](status.rs) | `GET /api/status` |
| [`context_view.rs`](context_view.rs) | `GET /api/context` |
| [`model_switcher.rs`](model_switcher.rs) | `GET /api/endpoints`, `POST /api/sessions/{id}/model` |
| [`turn_control.rs`](turn_control.rs) | `POST /api/sessions/{id}/steer`, `POST /api/sessions/{id}/stop` |
| [`test_support.rs`](test_support.rs) | the in-memory host the route tests run against (`#[cfg(test)]` only) |

## Read next

[`../INDEX.md`](../INDEX.md) for what the crate ports, what judges it, and its port plan.
