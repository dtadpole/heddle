---
title: The heddle-web-composer crate
version: 0.4.0
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
| Status | **on `main` and mounted by `heddle web`; the four checks pass 33/33 through `HEDDLE_BIN` once the context row lands (see below) — 43 unit tests, 7 integration tests behind a door double** |
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
5. **`ROUTES` and the merge** — landed with the takeover, then cut to the three composer-owned pairs by D-039, with a
   test that a caller's own router and layer merge with these routes and cover them.
6. **Behind the door** — the integration test serves the router the way `heddle-server` will: core routes, the
   composer merged after them, the 404 fallback, and the door around all of it (below).
7. **Through the binary** (pending, not this crate's alone): `heddle-server` mounts [`router`](src/lib.rs) and the
   binary (or the server) implements the four host traits; then `80-web-ui` check-composer, check-context-view,
   check-runtime-context and check-model-switcher run through `HEDDLE_BIN`. The traits' shapes are fixed and each
   route is judged against a host double, so the adapter work is a mapping over the crates' own APIs – the four
   host crates (`heddle-context`, `heddle-config`, `heddle-llm`, `heddle-session`) are still `todo!()` on `main`.

## The routes against the checks' API expectations, behind the server's door

[`tests/check_expectations.rs`](tests/check_expectations.rs) serves the composer the way the binary will, through a
**door double** in [`tests/support/mod.rs`](tests/support/mod.rs) read from `heddle-server` at developer-ten's
`72fdb4f` (`door` and `ServerBuilder::build` in `server.rs`, `fence.rs`, `token::authorize`, `respond.rs`), in the
server's order: the Host/Origin fence (`403`, before any credential), the decision (cookie first, then `?token=`),
the cross-site write rule (`403` when a state-changing request *offered* a cookie that failed), `401 unauthorized`
for `/api`, then the routes — the server's core, the composer merged after them through the same caught-panic merge
the server turns into `ServerError::Route`, and `404 not found` for an unclaimed path **and** a wrong method, inside
the door. Not reproduced, because no composer route meets them: favicon/`/healthz`, the `/?token=` handshake, the
page, and the cookie's HMAC (the double verifies one fixed value).

**The 13 expectations the four checks read hold behind the door**, each the exact status, sentence or body a check
asserts (`/api/status`, steer and stop are the server's since D-039, and the double's core serves them from this
crate's modules):

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

**And what the door adds — the merge risk the lane cannot see until `heddle web` boots** — six more tests:

| Test | What it would catch |
|---|---|
| the runtime-context check's `?token=` opens the door, and the routes ignore the extra query key | a stricter query extractor answering `400` to every request that check makes |
| the fence refuses a foreign `Host`, a `null` Origin and a foreign Origin with the server's sentences, even with a valid cookie; a loopback Origin on another port passes | composer routes reachable around the fence |
| an unauthenticated request gets `401 unauthorized`, not the route's own `400`/`200` | the composer mounted outside the token layer |
| a stale cookie on a switch is the cross-site write refusal (`403`); on a read it is `401`; beside the launch token it passes | the decision's order (cookie, then token) or the write rule drifting |
| an unclaimed path and a wrong method on a composer path are `404 not found`, and both are `401` without a credential | axum's default `405` from a mounted method router, or the fallback outside the door |
| `ROUTES` is disjoint from the server's `CORE_ROUTES` (copied at `72fdb4f`); mounting succeeds; re-adding `/api/status` (the pre-D-039 router) is a start-up error naming the path | a regression of the D-039 split |

**The tests can fail, and fail for the right reason** — measured by mutating the double: dropping the method fallback
turns exactly the wrong-method test red (`405` for `404`); applying the door to the core before the composer is
merged (the composer's routes outside it) turns five of the seven red, leaving only the authorized 13 and the
collision test green. The client reads each answer by its `Content-Length` over a kept-alive connection: with
`Connection: close`, a `POST` the door refused before reading its body was closed with the body unread, the kernel
reset the socket, and the client lost the `401` — a test that passed or failed by timing. After the fix, 30
consecutive runs passed.

What is left for the four checks to run through `HEDDLE_BIN` is not in these routes: a binary that answers
`heddle web`, its `mount_router(heddle_web_composer::router(..))`, and a host implementation over the
session/context/model crates.

## Where the port stands (2026-10-23, branch `hd/developer-twelve`)

- **On `main`, mounted**: `heddle web` (`rust/crates/heddle/src/web.rs`) mounts `router()` — `GET /api/context`,
  `GET /api/endpoints`, `POST /api/sessions/{id}/model` (D-039) — over a host built from the binary's services;
  `/api/status`, steer and stop are the server's routes, kept here as modules with their answers and tests.
- **Judged through `HEDDLE_BIN`** (debug build, `node _tools_/verify-runner/run.mjs _verifiers_/80-web-ui/check-<name>.mjs`):

  | Tree | composer | context-view | runtime-context | model-switcher | total |
  |---|---|---|---|---|---|
  | ui lane `5f51a02` as it is | 24/25 | 0/2 | 1/1 | 5/5 | 30/33 |
  | the lane + this branch `a0689eb` + `hd/developer-ten-web` `1193ef8` (the context row) | 25/25 | 2/2 | 1/1 | 5/5 | **33/33** |

  The three failures on the lane are the profile's missing context plugin (`web.rs`, developer-ten, the context row);
  with it, context-view #1 still needed `58dfda7` here (the log read after assembling). Logs are kept under the
  reflection project's `_projects_/heddle/logs/developer-twelve/` (`lane-5f51a02-*`, `lane-plus-fixes-*`).
- **Tested**: 43 unit tests; 7 integration tests behind the door double (the 13 check expectations plus six door
  tests, each shown to fail under mutation). Verify with `_tools_/local-build/run test --manifest-path rust/Cargo.toml
  -p heddle-web-composer`, then `clippy … --all-targets -- -D warnings` and `fmt … --check` (the ui lane's gate).
- **Next step**: when the context row and this branch reach `main`, re-run the four checks on `main`'s binary. If
  `SERVER_CORE_ROUTES` in `tests/support/mod.rs` falls behind the server's `CORE_ROUTES`, update the copy.

## Read next

[`../INDEX.md`](../INDEX.md) for the other crates; [`../heddle-web-trajectory/`](../heddle-web-trajectory/INDEX.md)
for the Trajectory routes; [`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the parts.
