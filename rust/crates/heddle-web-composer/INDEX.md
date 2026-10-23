---
title: The heddle-web-composer crate
version: 0.2.0
description: The Rust port crate for the composer routes — runtime context, the context view, the model switcher and the tool catalog — its public API, what it needs from other crates, and its port plan.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
  - source: src/server/tool-catalog.ts and the /api/status, /api/context, /api/endpoints, /model, /steer and /stop routes of src/server/web.ts
  - source: _verifiers_/80-web-ui/check-composer.mjs, check-context-view.mjs, check-runtime-context.mjs, check-model-switcher.mjs
  - source: test/tool-catalog.test.ts, test/model-switcher.test.ts
---

# `rust/crates/heddle-web-composer`

The Rust port of the composer routes — runtime context, the context view, the model switcher and the tool
catalog. The crate owns **routes, not state**: everything a route reads or changes is reached through a host
trait declared here, so it builds and is tested against doubles before the crates holding that state exist.

| | |
|---|---|
| Ported from | `src/server/tool-catalog.ts`, the composer routes of `src/server/web.ts` |
| Judged by | `_verifiers_/80-web-ui` (check-composer, check-context-view, check-runtime-context, check-model-switcher), through the `heddle` binary |
| Sources | [`src/`](src/INDEX.md) |
| Status | **public API landed, bodies are `todo!()`** — implementation follows in the port plan below |

## Routes

| Route | Module | Host trait |
|---|---|---|
| `GET /api/status` | `status` | `StatusHost` |
| `GET /api/context?session=&endpoint=&model=` | `context_view` | `ContextHost` |
| `GET /api/endpoints` | `model_switcher` | `ModelHost` |
| `POST /api/sessions/{id}/model` | `model_switcher` | `ModelHost` |
| `POST /api/sessions/{id}/steer` | `turn_control` | `TurnControlHost` |
| `POST /api/sessions/{id}/stop` | `turn_control` | `TurnControlHost` |

`router(Arc<H>) -> axum::Router` mounts all six for any `H: ComposerHost` (blanket over the four traits); each
module also has its own `routes`. Status codes, error sentences and body bytes are the TypeScript build's —
`JSON.stringify(v, null, 2)` plus a newline, compact for `/api/status`, `/stop` and errors, always
`cache-control: no-store` — and each module's documentation tabulates them.

## Public API

| Item | What it is |
|---|---|
| trait `SessionLookup` | `session_events(id) -> Option<Vec<Value>>`, `session_exists(id)` — shared with `heddle-web-trajectory` |
| trait `StatusHost`, `status_view` | the deployment-default sandbox mode and workspace root |
| trait `ContextHost`, `context_view`, `context_notes` | assemble (first), then surface and notes; `ContextView` is the body |
| trait `ModelHost`, `with_discovered_windows`, `validate_model_switch` | the endpoint listing with provider-discovered windows; the switch's validation order |
| trait `TurnControlHost`, `validate_steer`, `Steer::content` | what runs, abort, attachments, recording the steer |
| `ToolSpec`, `ToolSchema`, `catalog_of`, `schema_for` | the tool catalog the Trajectory details pane shows (`ToolSpec` is temporary until `heddle-llm` publishes its own) |
| `http::{respond, json_pretty, json_compact, error, is_session_id, read_json, BodyRefusal, trimmed_field}` | the TypeScript server's answer shapes, shared with `heddle-web-trajectory` |

## What it needs from other crates

| From | What | Until it exists |
|---|---|---|
| `heddle-server` | merges `router`, wraps it in the token and fence layers, keeps `/api/turn` and its turn registry, and implements `TurnControlHost::is_running` / `abort_session` over that registry | doubles |
| `heddle-session` | events, existence, folder, surface (`nodes`, `replacements`), `setModel`, `userContent` | doubles |
| `heddle-context` | `assemble(handle, { cwd, tools, endpoint?, model? })` → the report | a double |
| `heddle-config` | `describeEndpoints`, `selectionProblem` | a double |
| `heddle-llm` | the model service (`names`, `list`, `endpoint`, `defaultEndpoint`), `contextWindowFromModelList`, `describeContent`, `ToolSpec` | doubles; a local `ToolSpec` |
| `heddle-sandbox` | the deployment mode and workspace root | a double |
| `heddle-web-files` | `readAttachments` for a steer's attachments | a double |

**Who implements the host traits over the real crates**: proposed — this crate's owner writes the adapter impls, once
those crates publish their APIs, in a module the composing crate (server or binary) only instantiates with its
handles. Until then the server can implement the traits itself.

## Port plan

1. **API** (this commit): types, traits, signatures, docs; `todo!()` bodies.
2. **`http` and `catalog`**: answer helpers, `read_json`'s 10 MiB / empty / invalid rules, `is_session_id`,
   `catalog_of` with `localeCompare`-compatible ordering; port `test/tool-catalog.test.ts`.
3. **Pure route logic**: `status_view`, `context_notes`, `context_view`, `with_discovered_windows`,
   `validate_model_switch`, `validate_steer` — each with tests of every refusal and of the validation order.
4. **Routes**: in-process tests through `tower::ServiceExt::oneshot` with host doubles — every row of each
   module's answer table, headers and bytes.
5. **Through the binary**: once mounted, `80-web-ui` check-composer, check-context-view, check-runtime-context
   and check-model-switcher through `HEDDLE_BIN`.

## Read next

[`../INDEX.md`](../INDEX.md) for the other crates; [`../heddle-web-trajectory/`](../heddle-web-trajectory/INDEX.md)
for the Trajectory routes; [`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the parts.
