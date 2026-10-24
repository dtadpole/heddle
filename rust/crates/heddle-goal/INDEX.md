---
title: The heddle-goal crate
created: 2026-10-23T00:55:27Z
modified: 2026-10-24T05:15:59Z
version: 0.5.0
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
| `GoalDriver`, `RoundRunner`, `GoalRoundSource`, `DriverRun`, `DriverOutcome`, `ResumeReport` | the reconciler: one chain per session on a spawned task, `request`/`advance` join it, `resume_at_start` is the server's boot sweep. `GoalDriver::with_runtime` pins the runtime chains run on, so a request from any thread works; with none at all a request answers `no-runtime` (`NO_RUNTIME_SENTENCE`) instead of panicking |
| `decide_goal_round`, `render_goal_round_prompt`, `RoundDecision`, `ROUND_LIMIT_CODE` | the pure decision and DSH's round prompt |
| `round::{AgentRoundRunner, round_target}` | the rounds over `heddle-agent`'s real turn: the session's endpoint and model, else the default endpoint, the round's `source` on the prompt. The binary keeps its own `GoalRounds` adapter on the same contract (`main` `445ea43`); this is the crate's tested equivalent |
| `DriverTrigger`, `SessionEdge`, `classify_session_event` | the goal-driver plugin's edges: `turn/completed`, turn activity, `goal/change` at rest |
| `tool::{goal_tool_specs, run_create_goal, run_get_goal, run_update_goal, tool_view, end_of_run}` | the three verbs over std and serde types; the boot wraps them as `heddle-tools` registry tools, so this crate needs no tools dependency |
| `http::{get_goal, post_goal}`, `cli::{goal_json, goal_text}` | the person's verbs and the `heddle goal` command, as exact bytes |
| `SessionLog`, `LogError`, `Clock`, `iso_timestamp` | the same ports as `heddle-todo`'s, kept separate so either plugin loads alone |

## What the other seats provide, and what they get

- **developer-eight (`heddle-session`)**: the store behind `SessionLog`; the round's user message must keep its
  `source` object (`{kind:"goal", goalId, revision, round}`) in the `message` event, which is what the fold counts.
- **developer-five (`heddle-agent`, `heddle-tools`)**: a turn the boot wraps as `RoundRunner` (prompt plus
  `source`, the session's endpoint and model); the tool trait the three verbs register through (`goal-tool` row).
- **developer-ten (`heddle-server`)**: serves `/api/goal` through its own `GoalService` port, with the bodies and
  statuses of `http::get_goal` and `http::post_goal`; the binary's `web.rs` implements that port over this crate's
  service, calls `GoalDriver::resume_at_start` at start and prints `resuming N active goal(s)`.
- **developer-two (`heddle`)**: builds the service from the `goal` row, the driver and the trigger from the
  `goal-driver` row (absent when a profile removes it), feeds the trigger from a bus listener on `session/event`,
  awaits `advance` after `--turn`, and dispatches `heddle goal` to `command::run`.

## Port plan

| Step | What | State |
|---|---|---|
| 1 | Public API, docs | landed |
| 2 | Decode, fold, event body, the service and its activation rule — every case of `test/goal.test.ts` | landed |
| 3 | The driver, the trigger and the boot sweep on Tokio — every case of `test/goal-driver.test.ts`, including the reentrant pass and the yield between rounds | landed |
| 4 | The tools, the routes and the command renderings, byte for byte with the TypeScript build | landed |
| 5 | Swap the doubles for `heddle-session`'s store (`SessionLog` is implemented for `SessionStore`), `heddle-agent`'s turn and `heddle-tools`' types | the store and the turn (`AgentRoundRunner`): landed; the tool types are wrapped by the boot |
| 6 | `check-goal` through `HEDDLE_BIN`, the restart case included | with the server and the binary |

## Read next

[`../INDEX.md`](../INDEX.md) for the other crates; [`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the parts.
