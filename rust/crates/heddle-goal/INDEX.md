---
title: The heddle-goal crate
version: 0.2.0
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
| Judged by | `_verifiers_/80-web-ui` (`check-goal`), through the `heddle` binary; unit tests port `test/goal.test.ts` and `test/goal-driver.test.ts` |
| Sources | [`src/`](src/INDEX.md) |
| Owner | seat `developer-six`; merges through `integrator-one` |

## Public API

| Item | What it is |
|---|---|
| `GoalRef`, `GoalPhase`, `GoalActivation`, `GoalBlockReason`, `GoalSnapshot`, `GoalView` | the shapes, serialized in the TypeScript key order (`{id, revision, objective, phase, maxGoalRounds, blockedReason?}`, the view adding `roundsStarted, createdAt, updatedAt, activation`) |
| `GoalChange`, `GoalOperation`, `FoldedGoal`, `decode_goal_change`, `fold_goal`, `goal_change_event` | the strict fold and the `goal/change` body, clear tombstones included; admitted rounds counted from attributed user messages |
| `GoalService`, `GoalConfig`, `CreateGoal`, `EditGoal`, `GoalIds` | `get`, `disarm`, `create`, `edit`, `pause`, `resume`, `complete`, `block`, `clear` — each a compare-and-set on `GoalRef`, serialized per service so two writers cannot both write revision n+1 |
| `GoalError`, `GoalErrorCode` | the nine `GOAL_*` codes, or a log failure |
| `GoalDriver`, `RoundRunner`, `GoalRoundSource`, `DriverRun`, `DriverOutcome`, `ResumeReport` | the reconciler: one chain per session on a spawned task, `request`/`advance` join it, `resume_at_start` is the server's boot sweep |
| `decide_goal_round`, `render_goal_round_prompt`, `RoundDecision`, `ROUND_LIMIT_CODE` | the pure decision and DSH's round prompt |
| `DriverTrigger`, `SessionEdge`, `classify_session_event` | the goal-driver plugin's edges: `turn/completed`, turn activity, `goal/change` at rest |
| `tool::{goal_tool_specs, run_create_goal, run_get_goal, run_update_goal, tool_view, end_of_run}` | the three verbs; the mirrors `ToolSpec`/`ToolAnswer` go when `heddle-tools`' API lands |
| `http::{get_goal, post_goal}`, `cli::{goal_json, goal_text}` | the person's verbs and the `heddle goal` command, as exact bytes |
| `SessionLog`, `LogError`, `Clock`, `iso_timestamp` | the same ports as `heddle-todo`'s, kept separate so either plugin loads alone |

## What the other seats provide, and what they get

- **developer-eight (`heddle-session`)**: the store behind `SessionLog`; the round's user message must keep its
  `source` object (`{kind:"goal", goalId, revision, round}`) in the `message` event, which is what the fold counts.
- **developer-five (`heddle-agent`, `heddle-tools`)**: a turn the boot wraps as `RoundRunner` (prompt plus
  `source`, the session's endpoint and model); the tool trait the three verbs register through (`goal-tool` row).
- **developer-ten (`heddle-server`)**: mounts `http::get_goal` and `http::post_goal`; calls
  `GoalDriver::resume_at_start` with every session at boot and prints `heddle web: resuming N active goal(s)`.
- **developer-two (`heddle`)**: builds the service from the `goal` row, the driver and the trigger from the
  `goal-driver` row (absent when a profile removes it), forwards `session/event` to the trigger, awaits
  `advance` after `--turn`, and prints `cli::goal_json`/`goal_text` for `heddle goal`.

## Port plan

| Step | What | State |
|---|---|---|
| 1 | Public API, docs | landed |
| 2 | Decode, fold, event body, the service and its activation rule — every case of `test/goal.test.ts` | landed |
| 3 | The driver, the trigger and the boot sweep on Tokio — every case of `test/goal-driver.test.ts`, including the reentrant pass and the yield between rounds | landed |
| 4 | The tools, the routes and the command renderings, byte for byte with the TypeScript build | landed |
| 5 | Swap the doubles for `heddle-session`'s store, `heddle-agent`'s turn and `heddle-tools`' types | when those APIs land |
| 6 | `check-goal` through `HEDDLE_BIN`, the restart case included | with the server and the binary |

## Read next

[`../INDEX.md`](../INDEX.md) for the other crates; [`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the parts.
