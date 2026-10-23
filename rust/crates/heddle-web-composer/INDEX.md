---
title: The heddle-web-composer crate
version: 0.3.0
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
| Status | **implemented and unit-tested — 36 tests; mounting by `heddle-server` and the binary is the remaining step** |
| Owner | `developer-twelve` since 2026-10-22 (D-037, from `developer-eleven`, whose `10a0bd5` is the base of this tree); `heddle-web-trajectory` stays `developer-eleven`'s |

## Routes

| Route | Module | Host trait | Mounted by `router`? |
|---|---|---|---|
| `GET /api/context?session=&endpoint=&model=` | `context_view` | `ContextHost` | yes |
| `GET /api/endpoints` | `model_switcher` | `ModelHost` | yes |
| `POST /api/sessions/{id}/model` | `model_switcher` | `ModelHost` | yes |
| `GET /api/status` | `status` | `StatusHost` | **no** — `heddle-server`'s `CORE_ROUTES` owns it |
| `POST /api/sessions/{id}/steer` | `turn_control` | `TurnControlHost` | **no** — the server's turn registry owns it |
| `POST /api/sessions/{id}/stop` | `turn_control` | `TurnControlHost` | **no** — the server's turn registry owns it |

The last three are the crate's **logic and tests** but not its mount: the server registers those paths itself, and a
duplicate would fail the binary's start-up with a route error, so `router` and `ROUTES` carry only the first three.

`check-runtime-context` asserts no composer route: it judges the Trajectory view's runtime-context rows
(`heddle-web-trajectory`) and the server's `/api/sessions/{id}/permission`; the composer's contribution to that
page is the composer card's markup, which the server serves. It is listed here because the assignment names it.

`router(Arc<H>) -> axum::Router` mounts the three composer-owned routes for any `H: ComposerHost` (blanket over the
four traits); each module also has its own `routes`, and [`ROUTES`](src/lib.rs) lists the three `(method, path)`
pairs so a caller can assert at boot that they do not collide with its own — the server's include the other three
row and `/api/turn`, `/api/sessions`, the session detail routes, `/api/tree`, `/api/workspaces`,
`/api/folders/session`, goals and approvals. Mounting is one line
once the caller's state is applied:

```ignore
let app = app_with_state_applied.merge(heddle_web_composer::router(Arc::new(host))).layer(token_layer);
``` Status codes, error sentences and body bytes are the TypeScript build's —
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
| `js` | the JavaScript behaviours the answer shapes and projections must reproduce (`Date.parse`/`toISOString`, UTF-16 slicing, `\s`, JSON stringification, `encodeURIComponent`, HTML escaping) |

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

1. **API** — types, traits, signatures, docs; `todo!()` bodies. Landed in `0e487cf`, rebased as `2e2e530`.
2. **`http` and `catalog`** — answer helpers, `read_json`'s 10 MiB / empty / invalid rules, `is_session_id`,
   `catalog_of` with `localeCompare`-compatible ordering; `test/tool-catalog.test.ts` ported.
3. **Pure route logic** — `status_view`, `context_notes`, `context_view`, `with_discovered_windows`,
   `validate_model_switch`, `validate_steer`, each with tests of every refusal and of the validation order.
4. **Routes** — in-process tests through `tower::ServiceExt::oneshot` with host doubles: every row of each
   module's answer table, headers and bytes.
5. **`ROUTES` and the merge** — landed with the takeover: the six pairs, and a test that a caller's own router and
   layer merge with these routes and cover them.
6. **Through the binary** (pending, not this crate's alone): `heddle-server` mounts [`router`](src/lib.rs) and the
   binary (or the server) implements the four host traits; then `80-web-ui` check-composer, check-context-view,
   check-runtime-context and check-model-switcher run through `HEDDLE_BIN`. The traits' shapes are fixed and each
   route is judged against a host double, so the adapter work is a mapping over the crates' own APIs – the four
   host crates (`heddle-context`, `heddle-config`, `heddle-llm`, `heddle-session`) are still `todo!()` on `main`.

## The routes against the checks' API expectations

Committed as [`tests/check_expectations.rs`](tests/check_expectations.rs): it mounts `router` on a real listener over
a fixed in-memory host and speaks HTTP to it, so the contract the four checks read is a regression test in the crate
rather than a manual run. **13 of 13 hold**, each the exact status, sentence or body a check asserts —

| Expectation (and the check that needs it) | Answer |
|---|---|
| `GET /api/status` is compact, `{"sandbox":{"mode"},"cwd"}` (composer) | holds |
| `GET /api/context` without a session is `400 a session is required` (context-view) | holds |
| `GET /api/context?session=<unknown>` is `404 no session <id>` (context-view) | holds |
| `GET /api/context?session=<known>` carries session, instructions, contextWindow, thresholdTokens, surface and a `null` endpoint (context-view) | holds |
| `GET /api/endpoints` is pretty, with the nominated default and each endpoint's entry (model-switcher) | holds |
| `POST /api/sessions/<malformed>/model` is `400 not a session id` (model-switcher) | holds |
| a model switch refuses an unconfigured endpoint, then an undeclared model, then records a valid one (model-switcher) | holds |
| `POST /api/sessions/<malformed>/steer` is `400`, and a steer with no running turn is `409 session/steer-unavailable`, with `a prompt is required` decided first (composer) | holds |
| `POST /api/sessions/<id>/stop` answers `{"stopped":0,"session":…}` (composer) | holds |

The same expectations were first checked by hand through a throwaway stand-in host, and are now the test above. What is
left for the four checks to run through `HEDDLE_BIN` is not in these routes: a binary that answers
`heddle web`, the server mounting `router` behind its token and fence layers, and a host implementation over the
session/context/model/turn crates (their APIs are still `todo!()` on `main`, so the adapters are a mapping that
cannot be written against them yet).

## Read next

[`../INDEX.md`](../INDEX.md) for the other crates; [`../heddle-web-trajectory/`](../heddle-web-trajectory/INDEX.md)
for the Trajectory routes; [`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the parts.
