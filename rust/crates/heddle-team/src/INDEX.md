---
title: The heddle-team sources
version: 0.4.0
description: The sources of the heddle-team crate, with unit tests beside the code.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
  - source: src/team/ and src/plugins/team.ts in the TypeScript build
---

# `rust/crates/heddle-team/src`

The sources of the crate, with unit tests in `#[cfg(test)]` modules beside the code.

| File | What it is |
|---|---|
| [`lib.rs`](lib.rs) | the crate root, its documentation and re-exports |
| [`error.rs`](error.rs) | `TeamError` and the stable `TEAM_*` codes |
| [`state.rs`](state.rs) | the pure layer: events, the strict fold, member lifecycle, the compare-and-set board, the mailbox ledger |
| [`service.rs`](service.rs) | the service: spawn, send with target-confirmed delivery, the board with journaling, wait, interrupt, recovery |
| [`tool.rs`](tool.rs) | the nine model-facing tools: specs and a dispatcher |
| [`policy.rs`](policy.rs) | the collaboration policy and its durable note |
| [`plugin.rs`](plugin.rs) | the `team` profile row: composition, policy upkeep, `team/changed`, boot recovery |
| [`api.rs`](api.rs) | the `GET /api/team` answer |
| [`command.rs`](command.rs) | the D-043 entry point: the team half of `web`'s startup edge |
| [`ports.rs`](ports.rs) | the seams to the session store, the agent loop and the live-turn registry |
| [`testing.rs`](testing.rs) | in-memory doubles of the ports (feature `test-doubles`) |
| [`compose.rs`](compose.rs) | the `team` row composed over the session store, the agent, the tool registry and the server (feature `compose`) |

## Read next

[`../INDEX.md`](../INDEX.md) for what the crate ports, its seams and its port plan.
