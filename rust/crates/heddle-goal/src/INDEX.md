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
| [`round.rs`](round.rs) | `AgentRoundRunner`: each round answered by one real `heddle-agent` turn, tested end to end on a scripted endpoint |
| [`store.rs`](store.rs) | `SessionLog` for `heddle-session`'s `SessionStore`, tested against a real store on disk |
| [`tool.rs`](tool.rs) | `create_goal`, `get_goal`, `update_goal` as specs and functions |
| [`http.rs`](http.rs) | `GET` and `POST /api/goal` |
| [`command.rs`](command.rs) | `heddle goal [session] [--json]`, behind the binary's entry-point convention (D-043) |
| [`cli.rs`](cli.rs) | `heddle goal`'s two renderings |
| [`test_support.rs`](test_support.rs) | the in-memory log, fixed clock and fixed ids the tests use (tests only) |

## Read next

[`../INDEX.md`](../INDEX.md) for what the crate ports and what judges it.
