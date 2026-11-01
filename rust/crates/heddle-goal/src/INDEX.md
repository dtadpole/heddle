---
title: The heddle-goal sources
created: 2026-10-23T00:55:27Z
modified: 2026-10-31T07:46:54Z
version: 0.4.2
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
| [`driver.rs`](driver.rs) | the round decision and prompt, `GoalDriver` (on a pinned runtime, so the trigger can be fed from any thread), `DriverTrigger`; `TurnEnd` and `turn_ended`: a stopped goal round pauses its goal, another abnormal end disarms (#93); a round the archived-session gate refuses before its step blocks its goal `prompt-rejected`, and a `turn/failed` ends the busy span without a pass, disarming unless it is that refusal (#26) |
| [`log.rs`](log.rs) | the `SessionLog` and `Clock` ports and `iso_timestamp`; `SessionLog::meta` gives the tools a session's `delegationDepth` |
| [`round.rs`](round.rs) | `AgentRoundRunner`: each round answered by one real `heddle-agent` turn, tested end to end on a scripted endpoint |
| [`store.rs`](store.rs) | `SessionLog` for `heddle-session`'s `SessionStore`, tested against a real store on disk |
| [`tool.rs`](tool.rs) | `create_goal`, `get_goal`, `update_goal` as specs and functions — DSH's `dsh-tool-goal`: the verbs `edit`, `pause`, `resume`, `complete`, `blocked` (`update` an unadvertised alias of `edit`), a string `blocked_reason`, the block threshold, and authority read from the session's log (a direct human turn, or the goal's current round) |
| [`http.rs`](http.rs) | `GET` and `POST /api/goal` |
| [`command.rs`](command.rs) | `heddle goal [session] [--json]`, behind the binary's entry-point convention (D-043) |
| [`cli.rs`](cli.rs) | `heddle goal`'s two renderings |
| [`test_support.rs`](test_support.rs) | the in-memory log, fixed clock and fixed ids the tests use (tests only) |

## Read next

[`../INDEX.md`](../INDEX.md) for what the crate ports and what judges it.
