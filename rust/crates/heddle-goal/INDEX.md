---
title: The heddle-goal crate
created: 2026-10-23T00:55:27Z
modified: 2026-10-29T14:33:21Z
version: 0.7.0
description: The Rust port crate for session goals — the event-sourced state machine, the model's three verbs, the round driver and its trigger, and the goal routes — its public API and the port plan.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
  - source: src/goal/service.ts, src/goal/tool.ts, src/goal/driver.ts, src/plugins/goal-tool.ts, src/plugins/goal-driver.ts, the /api/goal branches of src/server/web.ts and the goal command of src/cli.ts, read 2026-10-22
  - source: _verifiers_/80-web-ui/check-goal.mjs
---

# `rust/crates/heddle-goal`

The Rust port of session goals, their driver and their tools.

| | |
|---|---|
| Ported from | `src/goal/service.ts`, `src/goal/tool.ts`, `src/goal/driver.ts`, `src/plugins/goal-tool.ts`, `src/plugins/goal-driver.ts`, `/api/goal` in `src/server/web.ts`, `heddle goal` in `src/cli.ts` |
| Judged by | `_verifiers_/80-web-ui` (`check-goal`) and `_verifiers_/50-agentic-loop` (`check-goal-tool`, `check-goal-rounds`), through the `heddle` binary; unit tests port `test/goal.test.ts`, `test/goal-tool.test.ts` and `test/goal-driver.test.ts` |
| Sources | [`src/`](src/INDEX.md) |
| Owner | seat `developer-six`; merges through `integrator-one` |

## Articles

| Article | What it holds |
|---|---|
| [`public-api.md`](public-api.md) | Every public item of the crate, what it is, and the modules that hold them. |
| [`seats.md`](seats.md) | What each dependent or providing seat supplies, and what it gets from this crate. |
| [`port-plan.md`](port-plan.md) | The steps of the port and what each landed. |

## Read next

[`../INDEX.md`](../INDEX.md) for the other crates; [`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the parts.
