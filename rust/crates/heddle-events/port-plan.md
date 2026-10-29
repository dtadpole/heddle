---
title: The heddle-events port plan
created: 2026-10-23T00:55:27Z
modified: 2026-10-25T13:48:26Z
level: L1
version: 1.0.1
description: The steps of the port, what each landed, and how part 6 is judged.
status: unverified
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
  - source: node_modules/@deepseek-ai/cordis/src/events.ts (Cordis 4.0.4), read 2026-10-22
  - source: the event declarations in src/events.ts, src/llm/service.ts, src/llm/types.ts, src/tools/service.ts, src/agent/loop.ts, src/approvals/service.ts, src/plugins/team.ts, and the hooks command in src/cli.ts
  - source: _verifiers_/60-hooks/check.mjs
---

# The heddle-events port plan

| Step | What | State |
|---|---|---|
| 1 | Public API, docs, catalog and its tests | landed |
| 2 | The bus: table, scopes and children, `once`, snapshot dispatch, the five modes, error attribution; unit tests for each Cordis rule (order, prepend, once, snapshot, release with scope and parent, veto, replace, map, attribution, parallel collection, serial and bail stop) | landed |
| 3 | The JSON bridges and the `expose_*` registry, tested with an in-memory `JsonListener` | landed |
| 4 | `StdioListener`: spawn, correlate by `id`, timeouts, child death, stderr to the log; tested against a small script child | landed |
| 4b | The component shape (D-031): listeners declared in `initialize`, `merge` for a post-execute rewrite that keeps the tool's result, `RpcListener` so one process serves tools and listeners, and a child's own requests answered without id collisions | landed |
| 4c | The port bridge: `llm`, `tools` and `agent` intercept through ports of their own, synchronous and without this crate; `bridge` makes an adapter over the bus a few lines in whichever crate holds it | landed |
| 4d | The port adapters (`ports`): the boot passes one `BusHooks` where it passes the no-listener defaults today, for model requests, tool calls and rounds | landed |
| 5 | `60-hooks` through `HEDDLE_BIN`: the binary advertises `hooks` and `--turn` since `main` `b72cc1a` (D-048), and the lane judges the part through the release binary: **6 of 6** (`rust/status.md`, part 6). Re-run on every candidate that touches this crate, the hook points, the goal driver or the turn: 6 of 6 on `main` `445ea43` (2026-10-24), and the verifier's `_tests_/process-hooks` 6 of 6 | met |

## Read next

[`INDEX.md`](INDEX.md) for the crate.
