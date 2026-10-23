---
title: The heddle-context crate
version: 0.4.0
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
| Sources | [`src/`](src/INDEX.md) |
| State | the API is declared and implemented behind it: the pure modules, the store double, the pruner, the compaction engine and the service, with unit tests beside each; the message types are `heddle-llm`'s, re-exported. Step 5's remaining half is the `ContextStore` adapter for `heddle-session`'s store, which waits on that store reaching `main`; step 6 waits on the loop and the command line |

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
| `service` | `service.ts` | `ContextService<S: ContextStore>::{budget, measure, record_runtime_context, ensure_context, assemble, prepare, recover_overflow}`; `ContextConfig` (the profile row's `config`), `ContextReport` with `summary()` and `view()`, the `ModelAccess` trait |
| `events` | the log vocabulary | `ContextEvent`: the `context/note` and `compaction/*` events this crate writes, typed |
| `store` | `PrunableStore` | the `ContextStore` trait this crate needs from the session store; `LogEvent`, `SurfaceState`, `SurfaceOp`, `AppendOptions` |
| `types` | `src/llm/types.ts` | `heddle-llm`'s `Message`, `ContentPart`, `Role`, `ToolSpec`, `TokenUsage`, `describe_content`, `CONTEXT_WINDOW_EXCEEDED`, re-exported under the same names; plus `text_message` for the single-block notes this crate writes |
| `testing` | — | `MemoryStore`, an in-memory `ContextStore` with the TypeScript fold rules; behind the `testing` feature |

### How the other crates call it

- **The agent loop** (`heddle-agent`), each round: `record_runtime_context(session, &[sandbox:policy])`, then
  `prepare(session, &PrepareOptions { cwd: <the session's folder>, endpoint, model, tools, system, .. })`; it
  writes `report.breakdown`, `estimated_tokens`, `threshold_tokens`, `pruned` and `compacted` on `model/request`,
  and reports `report.summary()` as the turn's `context`. On a refused call it calls `recover_overflow`, and on
  `RecoveryDecision::Retry` re-derives with `assemble` (it does not reduce again) and retries once.
- **The command line** (`heddle`): `heddle context <session> --json` is `assemble(...)` with the session's folder,
  every tool's schema, and `--endpoint`/`--model`, printed as `report.view(session_id)`. The boot builds one
  `ContextService` from the profile's context row (`ContextConfig` deserialises its `config`), `HEDDLE_HOME` and a
  `ModelAccess` over the model layer, and registers `recover_overflow` on `agent/request-error`.
- **The composer's context view** (`heddle-web-composer`) reads `assemble`'s report, and the recorded
  `breakdown` on `model/request`.

## What it builds against

| Needed from | What | State |
|---|---|---|
| `heddle-llm` | `Message`, `ContentPart`, `Role`, `ToolSpec`, `TokenUsage`, `describe_content`, `CONTEXT_WINDOW_EXCEEDED`, and the endpoint window behind `ModelAccess` | **taken**: `types` re-exports `heddle_llm`'s under the same names, plus one helper, `text_message`; the dependency is on `main` |
| `heddle-session` | the store: read, count, surface fold, node derivation, append with a surface operation | the `ContextStore` trait stays here; the adapter `impl` for the real store lands in this crate once the store is on `main`. It is a **straight pass-through** only if `heddle-session` re-exports `heddle-llm`'s message types; while its stand-ins are its own types, the adapter would have to serialise every node to cross the type boundary, which this crate will not hide |
| `heddle-config` | the context row's `config` handed over for deserialising; `heddle_home()` | `ContextConfig: Deserialize`; `ContextDependencies::heddle_home`; the profile row is the boot's to hand over |
| `heddle-events` | registering `recover_overflow` on the `agent/request-error` waterfall | a plain async method; the boot wires it |

## What `30-context-management` needs, and from whom

| Check | This crate | Other crates |
|---|---|---|
| a compaction shadows a span; the summary is read once | `compact`, the replacement note | the loop's `--turn --json` `context.compacted`; the `context` command; the scripted endpoint's `purpose: compaction` step |
| the budget is the endpoint's window | `budget` | the endpoint's `contextWindow` (`context_window_for`); `estimatedTokens` on `model/request` |
| trimming one result can clear the pressure | `prune_session` before `plan` | `write_file`/`read_file`; `context.pruned` |
| a cut never splits a pair, never shadows the prompt; a non-shrinking summary is refused | `plan`, `compact` | **imports `dist/` directly** — see the open question below |
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
5. **The real dependencies**: the `types` half landed (`heddle-llm` is on `main`; `types` now re-exports it and
   the same 97 tests pass). The `heddle-session` half — `impl ContextStore for SessionStore` — **waits**: the
   store is not on `main` yet, and the adapter is written once it is and `heddle-session` re-exports the same
   message types, so no per-node conversion is needed.
6. **The verifier**: with the loop and the command line composed, `30-context-management` through `HEDDLE_BIN`,
   reported to the lane integrator with the command and the date. **Waiting** on the loop and the command line.

## Deliberate differences from the TypeScript build

- **A plain struct, not a Cordis service.** The overflow listener is `recover_overflow`, wired by the boot.
- **The engine is given the store on each call** instead of holding it, so one engine serves every session.
- **A prune boundary inside a surrogate pair** keeps the whole character out of the kept part: a JavaScript string
  can hold a lone surrogate and a Rust `String` cannot. Lengths are otherwise UTF-16 code units, as in the
  TypeScript build, so estimates and prune points agree.
- **`String.prototype.trim()` is matched exactly** (it trims U+FEFF and not U+0085), so a baseline digest written by
  one build is recognised by the other.

## Open questions

- **For moving the verifiers onto `HEDDLE_BIN`:** the check *a cut never splits a tool call from its result* imports
  `dist/session/store.js` and `dist/context/{compaction,meter,budget}.js`, so under `HEDDLE_BIN` it still judges the
  TypeScript build, or is unjudged without one. The refusal half could go through the command line — a scripted
  `purpose: compaction` step returning 20,000 characters is a non-shrinking summary — but the cut half needs a seam
  both builds offer. This crate's unit tests cover both properties meanwhile.
- **For `heddle-session` and the workspace manifest:** the log's field order survives a `serde_json::Value` only with
  `serde_json`'s `preserve_order` feature; `ContextEvent` already declares the TypeScript order.
- `instruction_digest` needs a SHA-1 implementation; step 2 adds the `sha1` crate to this crate's manifest.

## Read next

[`../INDEX.md`](../INDEX.md) for the other crates; [`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the parts;
[`../../../src/context/INDEX.md`](../../../src/context/INDEX.md) for the TypeScript module and its constants.
