---
title: The heddle-llm crate
version: 0.3.0
description: The Rust port crate for the backend wire shapes, the HTTP client, streamed content and reasoning deltas, model info and usage — its public API, where it sits, the decisions behind the API, and the port plan.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
  - source: the TypeScript sources src/llm/, src/stream/printer.ts and src/plugins/model.ts, and their importers under src/, read 2026-10-22
  - source: _verifiers_/10-llm-backends, _verifiers_/20-streaming, _verifiers_/98-model-endpoints and _tools_/model-validation, read 2026-10-22
---

# `rust/crates/heddle-llm`

The Rust port of the backend wire shapes, the HTTP client, streamed content and reasoning deltas, model info and usage.

| | |
|---|---|
| Ported from | `src/llm/`, `src/stream/printer.ts`, the service half of `src/plugins/model.ts` |
| Judged by | `_verifiers_/10-llm-backends`, `_verifiers_/20-streaming`, `_verifiers_/98-model-endpoints`, through the `heddle` binary |
| Unit tests | `cargo test --manifest-path rust/Cargo.toml -p heddle-llm` — in-process doubles, no network |
| Sources | [`src/`](src/INDEX.md) |

**State: vocabulary ported.** The public types, traits and signatures are declared, their JSON shapes are final, and
the pure vocabulary of step 2 — finish reasons, `text_of`, `describe_content`, `request_messages`, usage, the failure
code and Title-Case headers, the SSE parser and driver, the attachment projection, `reasoning_configured` — is
implemented and tested in-process (44 unit tests, no network). The request builders, folds, transport and service are
`todo!()` until the port plan below reaches them; a dependent crate builds against the API and uses a test double where
it needs a body.

## Where it sits

**One heddle dependency: `heddle-config`, for the endpoint vocabulary.** `EndpointConfig`, `EndpointKind`,
`ModelEntry`, `ModelOption`, `ReasoningLevels`, `ReasoningLevel`, `ReasoningValue` and the catalogue lookups
(`offered_models`, `model_option`, `base_url_for`, `context_window_for`, `reasoning_levels_for`,
`reasoning_level_for`) are declared there and re-exported here, so a caller names one type whichever crate it
reaches it through. The three endpoint facts only a wire needs stay here as functions: `adapter::reasoning_configured`,
`attachments::accepts_images`, `model_info::has_model_list`.

Nothing else: in the TypeScript build nothing under `src/llm/` imports sessions or the event bus, and
`src/stream/printer.ts` reads only the `SessionEvent` type, which the printer here takes as JSON. The join of the model
service to configuration (`src/plugins/model.ts`) is the boot's: the binary resolves the endpoint list with
`heddle_config::resolve_endpoints` and calls [`ModelService::from_configuration`](src/service.rs).

Who uses what, from the TypeScript importers:

| Crate | Uses |
|---|---|
| `heddle` (`cli.ts`, boot) | `ModelService::{from_configuration, list, names, default_endpoint, generate, probe}`, `describe_content`, `StreamPrinter` |
| `heddle-context` | `Message`, `ContentPart`, `Role`, `ToolSpec`, `TokenUsage`, `Chunk`, `describe_content`, `CONTEXT_WINDOW_EXCEEDED` (its provisional `types` module becomes these re-exports) |
| `heddle-agent`, `heddle-tools` | `ModelService::stream`, `GenerateRequest`, `Chunk`, `ToolSpec`, `TokenUsage`, `merge_token_usage`, `ModelError` |
| `heddle-session` | `Message`, `ContentPart`, `Chunk` and their JSON, `text_of` |
| `heddle-team` | `ContentPart` |
| `heddle-server` (ledger) | `TokenUsage`, `merge_token_usage`, `billed_input_tokens` |
| `heddle-web-composer` (`web.ts`) | `ModelHooks` (the `model/request` selection rule), `reasoning_level_for`, `describe_content`, `ModelService::model_lists` |
| `heddle-web-files` | `ContentPart::{Image, File}`, `ImagePart`, `FilePart`, `ImageMediaType` |

## The public API

| Module | Items |
|---|---|
| [`types`](src/types.rs) | `ContentPart` (`Text`, `Reasoning`, `ToolCall`, `Image`, `File`), `ToolCall`, `ImagePart`, `FilePart`, `ImageMediaType`, `Role`, `Message`, `ToolSpec`, `GenerateRequest`, `Chunk` (`TextDelta`, `ReasoningDelta`, `ToolCallDelta`, `ToolCall`, `Done`), `HEALTHY_FINISH_REASONS`, `canonical_finish_reason`, `is_healthy_finish`, `text_of`, `describe_content`, `user_message`, `request_messages` |
| re-exported from `heddle-config` | `EndpointConfig`, `EndpointKind`, `ModelEntry`, `ModelOption`, `ReasoningLevels`, `ReasoningLevel`, `ReasoningValue` |
| [`error`](src/error.rs) | `ModelError { message, endpoint, code, status }`, `code::*` |
| [`usage`](src/usage.rs) | `TokenUsage`, `openai_chat_usage`, `openai_responses_usage`, `anthropic_usage`, `merge_token_usage`, `billed_input_tokens` |
| [`adapter`](src/adapter.rs) | `Adapter`, `ChunkStream`, `adapter_for`, `PreparedCall`, `reasoning_value`, `reasoning_configured`, `StreamFold`, `Folded`, `fold_sse` |
| [`chat`](src/chat.rs), [`responses`](src/responses.rs), [`anthropic`](src/anthropic.rs), [`scripted`](src/scripted.rs) | one adapter per wire shape, each with its pure request builder and fold |
| [`sse`](src/sse.rs), [`http`](src/http.rs) | `SseParser`, `read_sse`; `wire`, `WireRequest`, `WireResponse`, `title_case_headers`, `failure_code` |
| [`attachments`](src/attachments.rs) | `project_attachments`, `accepts_images`, the handle and placeholder texts, `IMAGE_REQUEST_LIMITS` |
| [`model_info`](src/model_info.rs) | `ModelListCache::{context_window, input_modalities}`, `InputModality`, `has_model_list`, `input_modalities_of_row`, `row_of` |
| [`service`](src/service.rs) | `ModelService`, `ModelHooks`, `HooksId`, `Generated`, `ProbeOptions`, `ProbeResult`, `with_discovered_modalities`, `last_assistant_text` |
| [`printer`](src/printer.rs) | `StreamPrinter`, `StreamPrinterOptions`, `StreamSummary` |

## Decisions in the API

1. **JSON is the TypeScript build's, byte for byte.** `ContentPart`, `Message`, `Chunk` and `TokenUsage` are written
   into the session log, so each serializes with its `type` tag first, its fields in the order the TypeScript code
   builds them, and absent optionals omitted — a message is `role`, `toolCallId`, `content`, `source`, the orders the
   loop writes a tool result and the session service a user message in. `Message` carries `source` so the one type
   serves the request and the log. The tests in `types.rs` pin each shape.
2. **`serde_json` with `preserve_order`.** A JSON object keeps insertion order, as `JSON.stringify` does. Cargo
   unifies features, so this applies to every crate in the binary — deliberately.
3. **The endpoint vocabulary is `heddle-config`'s**, re-exported, never redeclared.
4. **A stream is cancelled by dropping it.** No call takes an abort signal; a caller that races a stop with
   `tokio::select!` drops the stream and the request goes with it.
5. **The `model/request` and `model/stream` hooks are a trait, `ModelHooks`,** with Cordis's waterfall semantics
   (outermost first in registration order; `next()` runs the rest; not calling it vetoes). When `heddle-events`
   lands, the boot registers one implementation that dispatches to the bus; until then the seam works on its own.
6. **`ModelService::stream` returns `Result`**: `NO_ENDPOINT` is known before any stream exists, as the TypeScript
   call throws before iterating. Failures that happen while building or sending a request are stream items.
7. **Each wire shape is a pure request builder plus a pure fold** (`StreamFold`), driven over a live body by
   `fold_sse`, so the translation and the event vocabulary are tested without a socket.
8. **HTTP is `reqwest` with rustls**, built with `http1_title_case_headers`; the timeout is socket inactivity, not a
   total, so a long stream is not cut.

## Port plan

The TypeScript unit tests under `test/` are the oracle: each step ports the ones named, as Rust tests that can fail.

| Step | What | Oracle tests ported | State |
|---|---|---|---|
| 1 | The contract: every type, trait, signature and doc; JSON shapes final and tested | — | done |
| 2 | Pure vocabulary: finish reasons, `text_of`, `describe_content`, `request_messages`, `reasoning_configured`, `accepts_images`, usage, `failure_code`, `title_case_headers`, the SSE parser, attachment texts and projection, base64 | `finish-reasons`, `usage`, `request-messages`, `attachments` | done |
| 3 | Request builders and folds: chat, responses, anthropic; `reasoning_value`; the scripted adapter | `anthropic-vertex`, `responses-input`, `responses-finish`, `tool-call-delta`, `scripted-purpose`, `model-effort` (wire values), `model-gateways` | next (request builders wait for `heddle-config`'s catalogue lookups) |
| 4 | Transport: `wire` on reqwest, body sniffing, proxy form, failure codes; `fold_sse` and each adapter's `stream`, against in-process doubles of the three routes | `stream-arrival` | |
| 5 | `ModelService` (registry, default, hooks, modality discovery, `generate`, `probe`), `ModelListCache`, `StreamPrinter` | `model-info`, `model-info-per-model`, `model-discovery` | |
| 6 | Through the binary: `10-llm-backends` and `20-streaming` pass under `HEDDLE_BIN` once the CLI composes the service, the loop and the session log (see below) | the verifiers | |
| 7 | `98-model-endpoints` under `HEDDLE_BIN` (see below) | the verifier | |

**What steps 6 and 7 need from other crates.** The verifiers drive the CLI, so they pass only when the crates compose:

- `heddle`: `models --json` (the endpoint list as `describeEndpoint` prints it), `--endpoint`, `--turn`,
  `--stream` (a `StreamPrinter` on the session's events), `--json` (a summary carrying `endpoint`, `text`,
  `reasoning`, `session` and `stream`), `--max-output-tokens`, `--max-rounds`, `--resume`, `--session-root`,
  `--sandbox-root`, and the configured default endpoint when none is named;
- `heddle-agent`: a turn that calls `ModelService::stream` and hands each chunk to the session;
- `heddle-session`: `assistant/chunk` events emitted as they are appended;
- `heddle-config`: the endpoint ladder (`HEDDLE_CONFIG`, `HEDDLE_HOME`, environment overrides,
  `exclude`, the built-in `scripted` endpoint), `describe_endpoint`, and the catalogue lookup bodies, which every
  adapter calls (`base_url_for`, `reasoning_level_for`, …) — step 3 here needs them.

**`98-model-endpoints` judges the TypeScript adapters even under `HEDDLE_BIN`**: `_tools_/model-validation/validate.mjs`
imports `dist/llm/adapters.js` directly. Proposed: the binary gains a hidden command (working name
`heddle adapter-call`) that reads `{"endpoint": …, "request": …}` on stdin, runs `adapter_for(endpoint)?.stream(request)`,
and prints each `Chunk` as one JSON line (a failure as `{"type":"error","code":…,"message":…}`); `validate.mjs` uses
it when `HEDDLE_BIN` is set. The verifier itself makes no call and needs no change. The command is the binary's and the
validator change is the integrator's; `heddle-llm` provides everything the command calls.

## Read next

[`src/`](src/INDEX.md) for the module map; [`../INDEX.md`](../INDEX.md) for the other crates;
[`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the parts.
