---
title: The heddle-todo sources
version: 0.2.0
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
| [`tool.rs`](tool.rs) | `todo_write` and `todo_read` as specs and functions |
| [`http.rs`](http.rs) | `GET /api/todo` |
| [`test_support.rs`](test_support.rs) | the in-memory log, fixed clock and fixed ids the tests use (tests only) |

## Read next

[`../INDEX.md`](../INDEX.md) for what the crate ports and what judges it.
