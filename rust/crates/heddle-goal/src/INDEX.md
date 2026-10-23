---
title: The heddle-goal sources
version: 0.2.0
description: The sources of the heddle-goal crate, with unit tests beside the code.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
---

# `rust/crates/heddle-goal/src`

The sources of the crate, with unit tests in `#[cfg(test)]` modules beside the code.

| File | What it is |
|---|---|
| [`lib.rs`](lib.rs) | the crate root, its documentation and the re-exports |
| [`service.rs`](service.rs) | the shapes, the strict fold, the `goal/change` body and `GoalService` |
| [`driver.rs`](driver.rs) | the round decision and prompt, `GoalDriver`, `DriverTrigger` |
| [`log.rs`](log.rs) | the `SessionLog` and `Clock` ports and `iso_timestamp` |
| [`tool.rs`](tool.rs) | `create_goal`, `get_goal`, `update_goal` as specs and functions |
| [`http.rs`](http.rs) | `GET` and `POST /api/goal` |
| [`cli.rs`](cli.rs) | `heddle goal`'s two renderings |

## Read next

[`../INDEX.md`](../INDEX.md) for what the crate ports and what judges it.
