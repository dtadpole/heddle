---
title: The heddle-agent sources
version: 0.2.0
description: The sources of the heddle-agent crate, with unit tests beside the code.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
---

# `rust/crates/heddle-agent/src`

The sources of the crate, with unit tests in `#[cfg(test)]` modules beside the code.

| File | What it is |
|---|---|
| [`lib.rs`](lib.rs) | the crate root, its module map and its re-exports |
| [`turn.rs`](turn.rs) | `run_turn`, its options and result, and the loop's pure rules |
| [`turns.rs`](turns.rs) | `TurnRegistry`: which sessions have a turn in flight, and how to stop one |
| [`subagent.rs`](subagent.rs) | delegation to a child agent, and the `delegate` tool |
| [`ports.rs`](ports.rs) | what a turn asks of the model, session, context and hook services |
| [`upstream.rs`](upstream.rs) | provisional mirrors of types other crates own |

## Read next

[`../INDEX.md`](../INDEX.md) for what the crate ports, its API and its port plan.
