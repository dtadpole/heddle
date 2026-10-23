---
title: The heddle-agent crate
version: 0.4.0
description: The Rust port crate for the agentic loop, turns and subagents — its public API, what it asks of other crates, and its port plan.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
  - source: src/agent/loop.ts, src/agent/turns.ts, src/agent/subagent.ts, src/tools/subagent.ts, src/plugins/turns.ts, src/plugins/subagent-tool.ts — the TypeScript sources this crate ports
  - source: _verifiers_/50-agentic-loop/check.mjs and check-subagents.mjs — the checks that judge it
---

# `rust/crates/heddle-agent`

The Rust port of the agentic loop, turns and subagents.

| | |
|---|---|
| Ported from | `src/agent/loop.ts`, `src/agent/turns.ts`, `src/agent/subagent.ts`, `src/tools/subagent.ts`, `src/plugins/turns.ts`, `src/plugins/subagent-tool.ts` |
| Judged by | `_verifiers_/50-agentic-loop` (`check.mjs`, `check-subagents.mjs`), through the `heddle` binary |
| Sources | [`src/`](src/INDEX.md) |
| Unit tests | `cargo test --manifest-path rust/Cargo.toml -p heddle-agent` |

## Public API

| Item | What it is | Used by |
|---|---|---|
| `run_turn(&AgentRuntime, RunTurnOptions) -> Result<TurnResult, TurnError>` | one turn: prompt, rounds of model and tools, `assistant/completed`, `turn/completed` | `heddle` (`--turn`), `heddle-server` (web turns), `heddle-goal` (goal rounds), `heddle-team` (teammate turns) |
| `begin_turn(&AgentRuntime, RunTurnOptions) -> Result<BegunTurn, TurnError>`, `BegunTurn::{token, session, run}` | the same turn split so its live registration and its prompt (with `source` verbatim) are durable **before** the future is polled; the team layer reads the log immediately after `begin` | `heddle-team` (delivery, boot recovery), the binary |
| `AgentRuntime` | the turn's services: `model`, `session`, `context`, `tools` (`heddle_tools::ToolRegistry`), `hooks`, `turns` | built once by `heddle` (boot) |
| `RunTurnOptions` (`new(session, endpoint, prompt)`) | attachments, source, system, model, reasoning level, `RoundLimit` (8, or `Unbounded` for the web), max output tokens, overflow retries (1), purpose, `cancel` | the four callers above |
| `TurnResult`, `ToolCallRecord`, `Denial`, `ContextSummary`, `TurnError` | the turn's outcome, serialized in the TypeScript JSON shape | `heddle` (`--json`), `heddle-server` |
| `TurnRegistry`, `LiveTurn` | live turns per session: `begin(session, caller_token)`, `is_running`, `running`, `abort` | `heddle-team` (`list_agents`, `interrupt_agent`), `heddle-server` (Stop) |
| `delegate_subagent`, `subagent_tools`, `subagent_runner`, `SubagentConfig`, `SubagentLimits`, `SubagentError(Code)`, `final_assistant_text`, `parent_facts` | delegation to a child agent in its own session; the `delegate` tool; the `subagent-tool` row (`maxDepth` 2, `maxActive` 1) | `heddle` (boot), `heddle-team` |
| `ModelPort`, `SessionPort`, `ContextPort`, `TurnHooks`, `SubagentStore`, `SubagentRun` | what a turn and a delegation ask of other crates | implemented over `heddle-llm`, `heddle-session`, `heddle-context`, `heddle-events` |
| `adapters::LlmModel` | the `ModelPort` over `heddle-llm`'s `ModelService`: a Stop drops the provider stream, an unknown endpoint is one `NO_ENDPOINT` error item, the error keeps its code | the binary (boot) |
| `has_new_input`, `parse_arguments`, `merge_usage`, `turn::tool_message_text`, `turn::is_hook_refusal` | the loop's pure rules | the loop; tests |
| `upstream` | `heddle-llm`'s **own** `Message`, `Role`, `ContentPart`, `Chunk`, `TokenUsage`, `GenerateRequest`, `ToolCall`, `merge_token_usage`, re-exported; still **provisional mirrors**: `SessionEvent`, `SessionMeta`, `CreateSession`, `SurfaceView` (`heddle-session`); `ContextReport`, `PrepareOptions`, `RuntimeContextSection` (`heddle-context`). The sandbox and session-handle types are `heddle-tools`' re-exports, the sandbox ones already `heddle-sandbox`'s own | each mirror becomes a `pub use` of the owner's type when it lands |

The records the loop writes keep the TypeScript spelling: `model/request` (`ModelRequestRecord`, field order
included), `assistant/chunk`, the `tool` message (`error (<code>): <message>`, the output, or
`(the tool produced no output)`), `turn/retry`, `assistant/completed` (`text`, `reasoning`, `finishReason`,
`rounds`, `denials`, `ended`), `turn/completed`.

## Port plan

Each step lands with its unit tests in the worktree and is pushed to `hd/developer-five` for integrator-one.

| # | Step | State | Tests that can fail |
|---|---|---|---|
| 1 | Public API and mirrors; `TurnRegistry`; the pure rules (`has_new_input`, `parse_arguments`, tool message text, hook-failure sentence, `final_assistant_text`, `parent_facts`, usage merge) | **landed** | 17 unit tests, among them: an interrupt stops every turn of one session and no other; a caller's stop reaches the turn but an interrupt does not reach the caller; dropping a turn settles it; a completion replaces the last round's deltas |
| 2 | `run_turn`, `begin_turn` | **landed** | 23 unit tests with a scripted `ModelPort` and recording doubles: a multi-round task and the results reaching the next request; the round limit and its `ended` notice; a failing tool and an unknown tool answered, not fatal; a stop before a round and during a tool (`INTERRUPTED`, every call answered); steering takes another round; an overflow retried once only on `Retry`, with `turn/retry` and the landed compaction; an uncoded failure not retried; usage summed; the live turn registered while it runs, settled after, and stopped by an interrupt; a refused `agent/pre-step` naming the hook |
| 3 | `delegate_subagent`, `subagent_runner`, the `delegate` tool | **landed** | 15 unit tests: the refusal order (`SUBAGENT_NO_SESSION`, `SUBAGENT_EMPTY_PROMPT`, `SUBAGENT_DEPTH_EXCEEDED`, `SUBAGENT_BUSY`); the child's `parentSession`/`origin`/`delegationDepth`/folder/endpoint and the inherited mode; the parent's stop reaching the child; the in-flight slot released on success and on failure; an empty answer as `SUBAGENT_FAILED`; the tool's output naming the child with its data; the runner refusing a runtime with no endpoint; and, end to end in the loop, a `delegate` call returning the child's answer as the tool result with the turn continuing |
| 4 | Adapters over the real crates | **model landed**; session, context, events when those crates land | 6 unit tests for the model: the `heddle-llm` types replaced the mirrors (the loop sends `max_output_tokens` as `u64` and an empty `tools` as none, and reads `Chunk::ToolCall` as the owner's tuple), and `LlmModel` is tested against the real `ModelService` with a scripted endpoint — a round's tool call and its `tool_calls` finish, the next round's text, `NO_ENDPOINT` as one coded item, a scripted failure keeping its code for the retry rule, a Stop yielding nothing, the nominated default endpoint — plus a whole `run_turn` through the real service to its answer. `heddle_llm::ModelError` is not `Clone`, so the port converts it to the loop's `ModelError` (code and sentence) and `TurnError` keeps its derives. The `ContextPort` adapter is generic over `heddle-context`'s store, as its owner asked |
| 5 | `50-agentic-loop` (`check.mjs`, `check-subagents.mjs`) through `HEDDLE_BIN` | with `heddle` (`--turn`, `--resume`, `--max-rounds`), the scripted endpoint and the session store | the verifier, exit 0 |

`check-teams.mjs` in the same folder judges the team layer (`heddle-team`) and the server (`heddle-server`); this
crate supplies the turns and the live-turn registry they use.

## Read next

[`../INDEX.md`](../INDEX.md) for the other crates; [`../heddle-tools/INDEX.md`](../heddle-tools/INDEX.md) for the
registry a turn calls; [`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the parts.
