---
title: The heddle-todo sources
created: 2026-10-23T00:55:27Z
modified: 2026-10-23T05:06:23Z
version: 0.3.0
description: The sources of the heddle-todo crate, with unit tests beside the code.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
---

# `rust/crates/heddle-todo/src`

The sources of the crate, with unit tests in `#[cfg(test)]` modules beside the code.

| File | What it is |
|---|---|
| [`lib.rs`](lib.rs) | the crate root, its documentation and the re-exports |
| [`service.rs`](service.rs) | the shapes, validation, the fold, the `todo/write` body and `TodoService` |
| [`log.rs`](log.rs) | the `SessionLog` and `Clock` ports and `iso_timestamp` |
| [`store.rs`](store.rs) | `SessionLog` for `heddle-session`'s `SessionStore`, tested against a real store on disk |
| [`tool.rs`](tool.rs) | `todo_write` and `todo_read` as specs and functions |
| [`http.rs`](http.rs) | `GET /api/todo` |
| [`test_support.rs`](test_support.rs) | the in-memory log, fixed clock and fixed ids the tests use (tests only) |

## Read next

[`../INDEX.md`](../INDEX.md) for what the crate ports and what judges it.
