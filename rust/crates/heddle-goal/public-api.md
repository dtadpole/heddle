---
title: The heddle-goal public API
created: 2026-10-23T00:55:27Z
modified: 2026-10-31T07:46:54Z
level: L1
version: 1.3.1
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
| `GoalService`, `GoalConfig`, `CreateGoal`, `EditGoal`, `GoalIds` | `get`, `disarm`, `create`, `edit`, `pause`, `resume`, `complete`, `block`, `clear` — each a compare-and-set on `GoalRef`, serialized per service so two writers cannot both write revision n+1; `session_events` and `session_meta`, the log and the record the tools judge authority on |
| `GoalError`, `GoalErrorCode` | the nine `GOAL_*` codes, or a log failure |
| `GoalDriver`, `RoundRunner`, `GoalRoundSource`, `DriverRun`, `DriverOutcome`, `ResumeReport` | the reconciler: one chain per session on a spawned task, `request`/`advance` join it, `resume_at_start` is the server's boot sweep. `GoalDriver::with_runtime` pins the runtime chains run on, so a request from any thread works; with none at all a request answers `no-runtime` (`NO_RUNTIME_SENTENCE`) instead of panicking |
| `decide_goal_round`, `render_goal_round_prompt`, `RoundDecision`, `ROUND_LIMIT_CODE` | the pure decision and DSH's round prompt |
| `PROMPT_REJECTED_CODE`, `PROMPT_REJECTED_MESSAGE` | DSH's block for a round rejected before entering its step: a round that was not admitted and whose turn ended `turn/failed` `{"kind": "blocked"}` (the archived-session gate) blocks its goal, which a resume then starts (issue #26) |
| `round::{AgentRoundRunner, round_target}` | the rounds over `heddle-agent`'s real turn: the session's endpoint and model, else the default endpoint, the round's `source` on the prompt. The binary keeps its own `GoalRounds` adapter on the same contract (`main` `445ea43`); this is the crate's tested equivalent |
| `DriverTrigger`, `SessionEdge`, `classify_session_event` | the goal-driver plugin's edges: `turn/completed`, turn activity, `goal/change` at rest; `DriverTrigger::on_event(session, &event)` takes the whole event and reads how a turn ended (#93); `turn/failed` ends a turn's busy span and requests nothing, and disarms continuation unless it is the archived-session gate's `{"kind": "blocked"}` refusal (issue #26) |
| `TurnEnd`, `turn_end_of`, `GoalDriver::turn_ended` | how a turn ended (completed, stopped, failed, cut at the output limit) and what follows: a stopped goal round pauses its goal; any other abnormal end disarms continuation (DSH's `turn/end` and `agent/error` listeners) |
| `tool::{goal_tool_specs, run_create_goal, run_get_goal, run_update_goal, run_update_goal_with, tool_view, end_of_run}` | the three verbs over std and serde types, DSH's `dsh-tool-goal` (R-developer-nine-2, -3, -4); the boot wraps them as `heddle-tools` registry tools, so this crate needs no tools dependency. `run_update_goal` uses the default settings, as the TypeScript `goal-tool` plugin does |
| `tool::{GoalToolConfig, GoalToolSettings, GoalToolConfigError, resolve_goal_tool_config, DEFAULT_BLOCKED_AFTER_CONSECUTIVE_ROUNDS, goal_tool_guidance}` | DSH's `tool-goal` config (`blockedAfterConsecutiveRounds`, a positive safe integer, default 3) and its `tool:goal` prompt section |
| `tool::{UPDATE_ACTIONS, UpdateAction, CompletionAuthority, open_turn_events, is_top_level, has_direct_human_input, is_matching_goal_round, messages, codes}` | the verbs, the authority rules over a session's events and metadata record, and DSH's refusal sentences and codes |
| `http::{get_goal, post_goal}`, `cli::{goal_json, goal_text}` | the person's verbs and the `heddle goal` command, as exact bytes |
| `SessionLog`, `LogError`, `Clock`, `iso_timestamp` | the same ports as `heddle-todo`'s, kept separate so either plugin loads alone; `SessionLog::meta` (default `None`, a top-level session) is the session's metadata record |

## Read next

[`INDEX.md`](INDEX.md) for the crate.
