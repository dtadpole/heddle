---
title: Where heddle-llm sits
created: 2026-10-23T05:07:53Z
modified: 2026-10-23T05:09:31Z
level: L1
version: 1.0.0
description: The one heddle dependency of heddle-llm, why it has no other, and what each crate uses from it.
status: unverified
grounded_in:
  - source: the TypeScript sources src/llm/, src/stream/printer.ts and src/plugins/model.ts, and their importers under src/, read 2026-10-22
---

# Where heddle-llm sits

**One heddle dependency, `heddle-config`, for the endpoint vocabulary.** `EndpointConfig`, `EndpointKind`,
`ModelEntry`, `ModelOption`, the reasoning types and the catalogue lookups (`offered_models`, `model_option`,
`base_url_for`, `context_window_for`, `reasoning_levels_for`, `reasoning_level_for`) are declared there and
re-exported here, so a caller names one type whichever crate it reaches it through. The endpoint facts only a wire
needs stay here: `adapter::reasoning_configured`, `attachments::accepts_images`, `model_info::has_model_list`.

**Nothing else.** In the TypeScript build nothing under `src/llm/` imports sessions or the event bus, and
`src/stream/printer.ts` reads only the `SessionEvent` type, which the view here takes as JSON. The join to
configuration is the boot's: the binary resolves the endpoint list with `heddle_config::resolve_endpoints` and calls
`ModelService::from_configuration`.

## Who uses what

| Crate | Uses |
|---|---|
| `heddle` (boot, dispatch) | `ModelService::from_configuration`, `command::run` for `models`, `command::StreamHub` for `--stream` |
| `heddle-agent` | `ModelService::{stream, names, nominated}`, `GenerateRequest`, `Chunk`, `ModelError`, `command::{turn_endpoint, StreamView}` |
| `heddle-tools` | `ToolSpec` |
| `heddle-context` | `Message`, `ContentPart`, `Role`, `ToolSpec`, `TokenUsage`, `describe_content`, `CONTEXT_WINDOW_EXCEEDED`, `ModelService::generate` for summaries |
| `heddle-session` | `Message`, `ContentPart`, `Chunk` and their JSON, `text_of` |
| `heddle-team` | `ContentPart` |
| `heddle-server` (ledger) | `TokenUsage`, `merge_token_usage`, `billed_input_tokens` |
| `heddle-web-composer` | `ModelHooks` (the `model/request` selection rule), `reasoning_level_for`, `describe_content`, `ModelService::model_lists` |
| `heddle-web-files` | `ContentPart::{Image, File}`, `ImagePart`, `FilePart`, `ImageMediaType` |
