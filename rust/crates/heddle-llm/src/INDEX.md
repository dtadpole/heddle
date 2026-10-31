---
title: The heddle-llm sources
created: 2026-10-23T00:55:27Z
modified: 2026-10-31T03:00:00Z
version: 0.6.1
description: The sources of the heddle-llm crate, one module per TypeScript concern, with unit tests beside the code.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
  - source: the TypeScript sources src/llm/, src/stream/printer.ts and src/plugins/model.ts, read 2026-10-22
---

# `rust/crates/heddle-llm/src`

Unit tests sit in `#[cfg(test)]` modules beside the code.

| File | Ported from | What it is |
|---|---|---|
| [`lib.rs`](lib.rs) | — | crate root and re-exports |
| [`types.rs`](types.rs) | `llm/types.ts` | messages, parts, requests, chunks, finish reasons |
| [`error.rs`](error.rs) | `llm/types.ts` | `ModelError` and its codes |
| [`usage.rs`](usage.rs) | `llm/usage.ts` | `TokenUsage` and each provider's normalisation, merge and billed total |
| [`sse.rs`](sse.rs) | `llm/adapters.ts` | the incremental event-stream parser |
| [`http.rs`](http.rs) | `llm/http.ts` | the shared HTTP client |
| [`adapter.rs`](adapter.rs) | `llm/adapters.ts` | the `Adapter` trait and the fold driver |
| [`chat.rs`](chat.rs) | `llm/adapters.ts` | Chat Completions: request builder (a stream asks for its usage), message mapping (DeepSeek's reasoning replay), fold (usage from the finish frame or from OpenAI's own last frame) |
| [`responses.rs`](responses.rs) | `llm/adapters.ts` | Responses: request builder, input list, finish reason, fold |
| [`messages.rs`](messages.rs) | `llm/adapters.ts` | Anthropic's Messages API (`anthropic-messages`, kept by `heddle-config` as `EndpointKind::Other`): call builder, thinking form, JSON answer, adapter |
| [`anthropic.rs`](anthropic.rs) | `llm/adapters.ts` | Anthropic publisher route: call builder, message mapping, the fold both Anthropic kinds share |
| [`scripted.rs`](scripted.rs) | `llm/adapters.ts` | the offline scripted endpoint |
| [`attachments.rs`](attachments.rs) | `llm/attachments.ts` | file handles, image placeholders, the request image budget |
| [`model_info.rs`](model_info.rs) | `llm/model-info.ts` | the provider's model list: context window and input modalities |
| [`service.rs`](service.rs) | `llm/service.ts`, `plugins/model.ts` | `ModelService`, the `ModelHooks` seam, `generate`, `probe` |
| [`printer.rs`](printer.rs) | `stream/printer.ts` | the live stream view on standard error and its summary |
| [`command.rs`](command.rs) | `cli.ts` | `models`, `adapter-call`, the turn's endpoint, the `--stream` view and its hub |

## Read next

[`../INDEX.md`](../INDEX.md) for the crate, its decisions and its port plan.
