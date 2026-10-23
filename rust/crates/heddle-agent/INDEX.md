---
title: The heddle-agent crate
version: 0.5.0
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
| `adapters::Sessions`, `adapters::SessionSubagents` | the `SessionPort` and the `SubagentStore` over `heddle-session`'s `SessionService`; `model/request` written through the session crate's record in the TypeScript field order | the binary (boot) |
| `command` (`Command::Turn`, `Args`, `Context`, `run`, `resolve_endpoint`, `StreamView`, `GoalAdvance`) | the `--turn` command in the owning crate (D-043): config problems, endpoint, the folder's session or `--resume`/`--new`, the turn, the goal join, the TypeScript text or `--json` key for key, exit 1 on any denial but `UNKNOWN_TOOL` | the binary's dispatch |
| `adapters::Context<S>` (`new`, `over_session_handles`) | the `ContextPort` over `heddle-context`'s `ContextService<S>`, generic over its store; `prepare` with no summariser override and `force: false`, `assemble` for a granted retry | the binary (boot) |
| `has_new_input`, `parse_arguments`, `merge_usage`, `turn::tool_message_text`, `turn::is_hook_refusal` | the loop's pure rules | the loop; tests |
| `upstream` | `heddle-llm`'s **own** `Message`, `Role`, `ContentPart`, `Chunk`, `TokenUsage`, `GenerateRequest`, `ToolCall`, `merge_token_usage`, re-exported; still **provisional mirrors**: `SessionEvent`, `SessionMeta`, `CreateSession`, `SurfaceView` (`heddle-session`); `ContextReport`, `PrepareOptions`, `RuntimeContextSection` (`heddle-context`). The sandbox and session-handle types are `heddle-tools`' re-exports, the sandbox ones already `heddle-sandbox`'s own | each mirror becomes a `pub use` of the owner's type when it lands |

The records the loop writes keep the TypeScript spelling: `model/request` (`ModelRequestRecord`, field order
included), `assistant/chunk`, the `tool` message (`error (<code>): <message>`, the output, or
`(the tool produced no output)`), `turn/retry`, `assistant/completed` (`text`, `reasoning`, `finishReason`,
`rounds`, `denials`, `ended`), `turn/completed`.

## Where the port stands

As of 2026-10-22, branch `hd/developer-five`. Every body is ported; no `todo!()` is left. The model types are
`heddle-llm`'s own and `SessionEvent` is `heddle-session`'s; the session-meta, create-session and context-report
records are still this crate's, converted at the seam. Unit tests: 74, green, with the workspace gate.

- **Done:** `run_turn` and `begin_turn`, the live-turn registry, delegation and the `delegate` tool, the ports over
  the real crates (`adapters::{LlmModel, Sessions, SessionSubagents, Context}`; `Context::over_session_handles` binds
  `heddle-context`'s `impl ContextStore for SessionStore` directly, tested over the real store), and the D-043
  `--turn` entry point (`command::run`), tested over the real built-ins, sandbox, session store and a scripted model.
- **Open, not in this crate:** `50-agentic-loop` answers through `HEDDLE_BIN` once the binary dispatches `--turn` to
  `command::run` with an `AgentRuntime` composed from those adapters (its owner has the exact lines).
- **`--stream`:** the context takes a `StreamStarter`, called once the turn's session is open and before the turn
  runs (the TypeScript order); `heddle-llm`'s own `StreamView` implements this crate's trait, so the binary's
  starter builds `heddle_llm::command::print_stream(&handle.id, stderr)` and hands it to the session store's listener.
- **Hooks:** `TurnHooks` over the bus is `heddle-events`' (`BusHooks`), which depends on this crate; adding
  `heddle-events` as a dependency here would be a cycle.
- **Verify:** `_tools_/local-build/run test -p heddle-agent` from `rust/`; the verifier from the lane worktree,
  `HEDDLE_BIN="$PWD/rust/target/release/heddle" sh _verifiers_/50-agentic-loop/verify.sh`.

## Port plan

Each step lands with its unit tests in the worktree and is pushed to `hd/developer-five` for integrator-one.

| # | Step | State | Tests that can fail |
|---|---|---|---|
| 1 | Public API and mirrors; `TurnRegistry`; the pure rules (`has_new_input`, `parse_arguments`, tool message text, hook-failure sentence, `final_assistant_text`, `parent_facts`, usage merge) | **landed** | 17 unit tests, among them: an interrupt stops every turn of one session and no other; a caller's stop reaches the turn but an interrupt does not reach the caller; dropping a turn settles it; a completion replaces the last round's deltas |
| 2 | `run_turn`, `begin_turn` | **landed** | 23 unit tests with a scripted `ModelPort` and recording doubles: a multi-round task and the results reaching the next request; the round limit and its `ended` notice; a failing tool and an unknown tool answered, not fatal; a stop before a round and during a tool (`INTERRUPTED`, every call answered); steering takes another round; an overflow retried once only on `Retry`, with `turn/retry` and the landed compaction; an uncoded failure not retried; usage summed; the live turn registered while it runs, settled after, and stopped by an interrupt; a refused `agent/pre-step` naming the hook |
| 3 | `delegate_subagent`, `subagent_runner`, the `delegate` tool | **landed** | 15 unit tests: the refusal order (`SUBAGENT_NO_SESSION`, `SUBAGENT_EMPTY_PROMPT`, `SUBAGENT_DEPTH_EXCEEDED`, `SUBAGENT_BUSY`); the child's `parentSession`/`origin`/`delegationDepth`/folder/endpoint and the inherited mode; the parent's stop reaching the child; the in-flight slot released on success and on failure; an empty answer as `SUBAGENT_FAILED`; the tool's output naming the child with its data; the runner refusing a runtime with no endpoint; and, end to end in the loop, a `delegate` call returning the child's answer as the tool result with the turn continuing |
| 4 | Adapters over the real crates | **model, session, subagent store, context landed**; the hook adapter is the binary's (it attaches the event bus) | 6 unit tests for the model: the `heddle-llm` types replaced the mirrors (the loop sends `max_output_tokens` as `u64` and an empty `tools` as none, and reads `Chunk::ToolCall` as the owner's tuple), and `LlmModel` is tested against the real `ModelService` with a scripted endpoint — a round's tool call and its `tool_calls` finish, the next round's text, `NO_ENDPOINT` as one coded item, a scripted failure keeping its code for the retry rule, a Stop yielding nothing, the nominated default endpoint — plus a whole `run_turn` through the real service to its answer. `heddle_llm::ModelError` is not `Clone`, so the port converts it to the loop's `ModelError` (code and sentence) and `TurnError` keeps its derives. The session and context adapters add 7 more: the prompt with its `source` recorded and read back as user input; `model/request` keys in the TypeScript order; a child session carrying its parent, origin, depth and the parent's narrowed mode; an unknown origin refused; the context port preparing the request from the recorded surface and assembling the same request without reducing it (against the real `ContextService` over its in-memory store). And end to end: **a turn recorded through the real `SessionService` and the real `ModelService`** writes what `50-agentic-loop`'s `check.mjs` reads — one `model/request` per round, both tool results, the read carrying what the write wrote, a later request of five or more messages, `assistant/completed` with the answer, one `turn/completed`. The session and context crates keep their own record types; each adapter converts only at the seam |
| 4b | The `--turn` entry point (D-043) | **landed** | 12 unit tests over the real built-ins, sandbox, session store and a scripted model, from the verifiers' own scenarios: a write-then-read task printing the answer, each call and the session line, and leaving the file; the `--json` keys in the TypeScript order; an unknown tool refused by name with exit 0; a failing tool answered with exit 1; a configuration naming a tool nothing registered failing before any session, and failed rows on the same line; an unknown endpoint refused with the configured names; the folder's session continued, `--resume` reaching it, `--new` starting another; a missing resume id failing; the round limit respected and recorded; the goal driver joined and the bound folder registered; the sixty-character title |
| 5 | `50-agentic-loop` (`check.mjs`, `check-subagents.mjs`) through `HEDDLE_BIN` | with `heddle` (`--turn`, `--resume`, `--max-rounds`), the scripted endpoint and the session store | the verifier, exit 0 |

`check-teams.mjs` in the same folder judges the team layer (`heddle-team`) and the server (`heddle-server`); this
crate supplies the turns and the live-turn registry they use.

## Read next

[`../INDEX.md`](../INDEX.md) for the other crates; [`../heddle-tools/INDEX.md`](../heddle-tools/INDEX.md) for the
registry a turn calls; [`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the parts.
