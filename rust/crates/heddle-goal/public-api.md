---
title: The heddle-goal public API
created: 2026-10-23T00:55:27Z
modified: 2026-10-29T11:45:49Z
level: L1
version: 1.1.0
description: Every public item of the crate, what it is, and the modules that hold them.
status: unverified
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
  - source: src/goal/service.ts, src/goal/tool.ts, src/goal/driver.ts, src/plugins/goal-tool.ts, src/plugins/goal-driver.ts, the /api/goal branches of src/server/web.ts and the goal command of src/cli.ts, read 2026-10-22
  - source: _verifiers_/80-web-ui/check-goal.mjs
---

# The heddle-goal public API

| Item | What it is |
|---|---|
| `GoalRef`, `GoalPhase`, `GoalActivation`, `GoalBlockReason`, `GoalSnapshot`, `GoalView` | the shapes, serialized in the TypeScript key order (`{id, revision, objective, phase, maxGoalRounds, blockedReason?}`, the view adding `roundsStarted, createdAt, updatedAt, activation`) |
| `GoalChange`, `GoalOperation`, `FoldedGoal`, `decode_goal_change`, `fold_goal`, `goal_change_event` | the strict fold and the `goal/change` body, clear tombstones included; admitted rounds counted from attributed user messages, in log order and across revisions as DSH does (R-developer-two-31) |
| `GoalService`, `GoalConfig`, `CreateGoal`, `EditGoal`, `GoalIds` | `get`, `disarm`, `create`, `edit`, `pause`, `resume`, `complete`, `block`, `clear` — each a compare-and-set on `GoalRef`, serialized per service so two writers cannot both write revision n+1 |
| `GoalError`, `GoalErrorCode` | the nine `GOAL_*` codes, or a log failure |
| `GoalDriver`, `RoundRunner`, `GoalRoundSource`, `DriverRun`, `DriverOutcome`, `ResumeReport` | the reconciler: one chain per session on a spawned task, `request`/`advance` join it, `resume_at_start` is the server's boot sweep. `GoalDriver::with_runtime` pins the runtime chains run on, so a request from any thread works; with none at all a request answers `no-runtime` (`NO_RUNTIME_SENTENCE`) instead of panicking |
| `decide_goal_round`, `render_goal_round_prompt`, `RoundDecision`, `ROUND_LIMIT_CODE` | the pure decision and DSH's round prompt |
| `round::{AgentRoundRunner, round_target}` | the rounds over `heddle-agent`'s real turn: the session's endpoint and model, else the default endpoint, the round's `source` on the prompt. The binary keeps its own `GoalRounds` adapter on the same contract (`main` `445ea43`); this is the crate's tested equivalent |
| `DriverTrigger`, `SessionEdge`, `classify_session_event` | the goal-driver plugin's edges: `turn/completed`, turn activity, `goal/change` at rest |
| `tool::{goal_tool_specs, run_create_goal, run_get_goal, run_update_goal, tool_view, end_of_run}` | the three verbs over std and serde types; the boot wraps them as `heddle-tools` registry tools, so this crate needs no tools dependency |
| `http::{get_goal, post_goal}`, `cli::{goal_json, goal_text}` | the person's verbs and the `heddle goal` command, as exact bytes |
| `SessionLog`, `LogError`, `Clock`, `iso_timestamp` | the same ports as `heddle-todo`'s, kept separate so either plugin loads alone |

## Read next

[`INDEX.md`](INDEX.md) for the crate.
