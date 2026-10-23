---
title: The heddle-context crate
created: 2026-10-23T00:55:27Z
modified: 2026-10-23T12:49:45Z
version: 0.9.0
description: The Rust port crate for the surface over the log, the window budget, pruning and compaction — its public API and its port plan.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
  - source: src/context/ and its INDEX.md, the TypeScript build this crate ports
  - source: _verifiers_/30-context-management/check.mjs, the contract this crate is judged by
---

# `rust/crates/heddle-context`

The Rust port of what a model call is actually sent: the surface over the log, priced by a meter against
the routed endpoint's window, reduced by pruning before it is reduced by compaction.

| | |
|---|---|
| Ported from | `src/context/` (1,726 lines in seven files) |
| Judged by | `_verifiers_/30-context-management`, through the `heddle` binary |
| Sources | [`src/`](src/INDEX.md); integration tests in `tests/`: `typescript-agreement.rs` (prices, budgets, prune text and digests measured from the TypeScript build) and `engine-agreement.rs` (the TypeScript store and engine's own record of four scenarios, `tests/fixtures/engine-oracle.json`, replayed and compared event for event; regenerate it with `node tests/fixtures/generate-engine-oracle.mjs`) |
| State | the API is declared and implemented behind it: the pure modules, the store double, the pruner, the compaction engine and the service, with unit tests beside each; the message types are `heddle-llm`'s, re-exported, and `ContextStore` is bound to `heddle-session`'s store. Step 6, the verifier through the binary, waits on the loop and the command line |

## Public API

Everything is re-exported at the crate root. The module docs carry the rules; this is the map.

| Module | Ports | The API |
|---|---|---|
| `meter` | `meter.ts` | `CHARS_PER_TOKEN`, `BLOCK_OVERHEAD`, `ROLE_OVERHEAD`; `estimate_part`, `estimate_content`, `estimate_message`, `estimate_tools`; `TokenMeter::measure(&MeterInput) -> Measurement` (`MeterNode`, `Baseline`, `UsageAnchor`) |
| `budget` | `budget.ts` | `THRESHOLD_RATIO`, `RETAIN_RATIO`; `resolve_budget(&BudgetInput) -> Result<Budget, BudgetError>`; `BudgetPolicy`, `EndpointPolicy`, `BudgetErrorCode::{NoCapacity, RetainNotBelowThreshold}` |
| `prune` | `prune.ts` | `PRUNE_*` constants, `PRUNE_MARKER`; `prune_text`; `ToolResultPruner::{new, with_estimator, prune_session}` |
| `compaction` | `compaction.ts` | `COMPACTION_INSTRUCTION`, `SUMMARY_OPEN_TAG`/`CLOSE`; `frame_summary`, `tool_pairing_balanced_before`; `CompactionEngine::{plan, compact, compact_if_needed}`; the `Summarizer` trait (any async closure is one) |
| `instructions` | `instructions.ts` | `INSTRUCTIONS_MAX_BYTES`, the file names; `find_project_root`, `find_instruction_files`, `instruction_digest`, `render_instruction_baseline` |
| `pairing` | `pairing.ts` | `repair_tool_pairing(&[Message]) -> Cow<[Message]>` |
| `runtime` | `service.ts` | `RUNTIME_CONTEXT_*`, `RuntimeContextSection`, `render_runtime_context` |
| `command` | `src/cli.ts` (the `context` branch) | the command's entry point under D-043: `Command::Context`, `Args { target, json, endpoint, model }`, `Context { cwd, sessions, context, tools, workspace_root }`, `run(command, args, context, out, err) -> i32` |
| `service` | `service.ts` | `ContextService<S: ContextStore>::{budget, measure, record_runtime_context, ensure_context, assemble, prepare, recover_overflow}`; `ContextConfig` (the profile row's `config`), `ContextReport` with `summary()` and `view()`, the `ModelAccess` trait |
| `events` | the log vocabulary | `ContextEvent`: the `context/note` and `compaction/*` events this crate writes, typed |
| `store` | `PrunableStore` | the `ContextStore` trait this crate needs from the session store; `LogEvent`, `EventRef` (a borrowed event for the scans), `SurfaceState`, `SurfaceOp`, `AppendOptions`. A round asks for the surface with `derive_surface` and scans the log with `visit_newest_first`, never node by node and never by copying the log |
| `types` | `src/llm/types.ts` | `heddle-llm`'s `Message`, `ContentPart`, `Role`, `ToolSpec`, `TokenUsage`, `describe_content`, `CONTEXT_WINDOW_EXCEEDED`, re-exported under the same names; plus `text_message` for the single-block notes this crate writes |
| `testing` | — | `MemoryStore`, an in-memory `ContextStore` with the TypeScript fold rules; behind the `testing` feature |
| `session_store` | `PrunableStore` | the real store bound to this crate's trait: `impl ContextStore for heddle_session::SessionStore`, a mapping only |

### How the other crates call it

- **The agent loop** (`heddle-agent`), each round: `record_runtime_context(session, &[sandbox:policy])`, then
  `prepare(session, &PrepareOptions { cwd: <the session's folder>, endpoint, model, tools, system, .. })`; it
  writes `report.breakdown`, `estimated_tokens`, `threshold_tokens`, `pruned` and `compacted` on `model/request`,
  and reports `report.summary()` as the turn's `context`. On a refused call it calls `recover_overflow`, and on
  `RecoveryDecision::Retry` re-derives with `assemble` (it does not reduce again) and retries once.
- **The command line** (`heddle`): `heddle context [<session>] [--json]` is `command::run` (D-043): the binary
  dispatches with `command::Args` and a `command::Context` holding the working directory, the session service, the
  context service, every tool's schema and the sandbox root; the command resolves the session, assembles with the
  session's own folder, and prints `ContextView` as `JSON.stringify(view, null, 2)` or `ContextView::render_text`.
  The boot builds one `ContextService` from the profile's context row (`ContextConfig` deserialises its `config`;
  an absent row is `{}` and takes every default), the session store, `HEDDLE_HOME`, and `heddle_llm::ModelService`
  itself as the `ModelAccess` (this crate implements it: the endpoint's declared window, one `generate` with
  `purpose: compaction`). The turn's `request_error` hook is `heddle_agent::adapters::ContextRecovery`, which calls
  `recover_overflow`, chained after the run's bus hooks so it answers in the waterfall order the TypeScript build's
  `agent/request-error` listeners have.
- **The composer's context view** (`heddle-web-composer`) reads `assemble`'s report, and the recorded
  `breakdown` on `model/request`.
- **The store the binary names**: `heddle_session::SessionStore` behind an `Arc`. `ContextService<S:
  ContextStore>` is generic and this crate provides the one `impl` for the real store (`session_store`), so a
  caller never writes a conversion; `MemoryStore` (behind the `testing` feature) is the double, not a
  production store.

## What it builds against

| Needed from | What | State |
|---|---|---|
| `heddle-llm` | `Message`, `ContentPart`, `Role`, `ToolSpec`, `TokenUsage`, `describe_content`, `CONTEXT_WINDOW_EXCEEDED`, and the endpoint window behind `ModelAccess` | **taken**: `types` re-exports `heddle_llm`'s under the same names, plus one helper, `text_message`; the dependency is on `main` |
| `heddle-session` | the store: read, count, surface fold, node derivation, append with a surface operation | **taken**: `impl ContextStore for heddle_session::SessionStore` lives in `session_store`. It is a straight pass-through — the session crate re-exports `heddle-llm`'s message types, so a node's message crosses without a conversion |
| `heddle-config` | the context row's `config` handed over for deserialising; `heddle_home()` | `ContextConfig: Deserialize`; `ContextDependencies::heddle_home`; the profile row is the boot's to hand over |
| `heddle-agent` | answering a refused call: one forced reduction, a retry only when it landed | `recover_overflow` is a plain async method; `heddle_agent::adapters::ContextRecovery` calls it from the turn's `request_error`, and the binary chains it after the bus |

## What `30-context-management` needs, and from whom

| Check | This crate | Other crates |
|---|---|---|
| a compaction shadows a span; the summary is read once | `compact`, the replacement note | the loop's `--turn --json` `context.compacted`; the `context` command; the scripted endpoint's `purpose: compaction` step |
| the budget is the endpoint's window | `budget` | the endpoint's `contextWindow` (`context_window_for`); `estimatedTokens` on `model/request` |
| trimming one result can clear the pressure | `prune_session` before `plan` | `write_file`/`read_file`; `context.pruned` |
| a cut never splits a pair, and the model keeps its system prompt | `plan` (backs off before an answered call; protects only a head system node, as the TypeScript planner does) | the loop's `--turn` with `write_file`/`read_file`; the `context` command |
| a summary that does not shrink is refused, the conversation left as it was | `compact` | the scripted endpoint's `purpose: compaction` step; the `context` command |
| one reduction and one retry on overflow | `recover_overflow` | the chat adapter mapping the 400 to `CONTEXT_WINDOW_EXCEEDED`; the loop's single retry and `turn/retry` event; the waterfall |
| the baseline comes from the session's folder and follows an edit | `ensure_context` | the session's recorded folder; the loop and the `context` command passing it |
| repeated compaction; notes are not turns | `plan` over out-of-order seqs | the page's display fold, imported from `dist/server/web.js` |
| the instruction budget drops whole files first | `render_instruction_baseline` | — |

## Port order

Each step lands with its unit tests (`cargo test --manifest-path rust/Cargo.toml -p heddle-context`), ported from
the TypeScript tests named.

1. **This API.** Landed.
2. **The pure modules**: `text`, `types`, `meter`, `budget`, `prune_text`, `pairing`, `runtime`, `instructions` —
   from `test/meter.test.ts`, `test/prune.test.ts` (the text half), `test/context-pairing.test.ts`, plus new tests
   for the instruction budget, the digest and the JavaScript string rules. Landed.
3. **`MemoryStore`, the pruner and the engine** — `test/prune.test.ts`, `test/surface.test.ts` (as the double's
   own tests), and the verifier's in-process scenario: a cut aimed inside a tool pair backs off before it, and a
   20,000-character summary is refused with the surface unchanged; a second compaction over out-of-order seqs.
   Landed.
4. **The service** — `test/runtime-context.test.ts`, `test/session-folder.test.ts` (the baseline half), the usage
   anchor, and overflow recovery with a scripted `ModelAccess`. Landed.
5. **The real dependencies**: landed. `types` re-exports `heddle-llm`'s, and `impl ContextStore for
   SessionStore` binds the real store, with three tests on a real on-disk session (write and read back, the
   pruner's rewrite, a compaction whose log keeps its span) and one that replays the TypeScript build's record of a
   landed compaction through it, event for event.
6. **The verifier**: **passes, 9 of 9, verdict 0, through `main`'s binary**, which serves `context` and `--turn`
   since `b72cc1a` (the lane integrator's release-build run on that commit, and this seat's debug-build runs on each
   later `main` that touched this crate, the session crate, the turn or the binary). Keeping it there is standing
   work: re-run `HEDDLE_BIN=<binary> sh _verifiers_/30-context-management/verify.sh` on any change to those, and
   report a drop at once.

## Deliberate differences from the TypeScript build

- **A plain struct, not a Cordis service.** The overflow listener is `recover_overflow`, wired by the boot.
- **The engine is given the store on each call** instead of holding it, so one engine serves every session.
- **A prune boundary inside a surrogate pair** keeps the whole character out of the kept part: a JavaScript string
  can hold a lone surrogate and a Rust `String` cannot. Lengths are otherwise UTF-16 code units, as in the
  TypeScript build, so estimates and prune points agree.
- **`String.prototype.trim()` is matched exactly** (it trims U+FEFF and not U+0085), so a baseline digest written by
  one build is recognised by the other.

## Open questions

- **Settled:** *compacted more than once, and the reader still sees the conversation* no longer reads `dist/`; it
  passes through the binary in the rehearsal above.
- **Settled:** the in-process check of the cut and the refusal is now two command-line checks (main `cc09a59`).
  `command.rs` replays that exact fixture through this crate (`the_verifiers_cut_pair_scenario_…`,
  `the_verifiers_cut_refused_scenario_…`). Through the command line the system prompt is a note appended when the
  round starts, after the first prompt, so it is not the head node and a plan may shadow it; the next round
  appends it again. That is the TypeScript build's behaviour and this crate keeps it.
- **For `heddle-session` and the workspace manifest:** the log's field order survives a `serde_json::Value` only with
  `serde_json`'s `preserve_order` feature; `heddle-session` enables it, and `ContextEvent` already declares the
  TypeScript order.

## Read next

[`../INDEX.md`](../INDEX.md) for the other crates; [`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the parts;
[`../../../src/context/INDEX.md`](../../../src/context/INDEX.md) for the TypeScript module and its constants.
