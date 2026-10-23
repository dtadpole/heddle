---
title: The heddle-server crate
version: 0.3.0
description: The Rust port crate for the HTTP server, the token, the live stream and the page it serves — its public API, the route table with owners, and the port plan.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
  - source: src/server/web.ts, src/server/token.ts, src/server/html.ts, read in full on 2026-10-22
  - source: _verifiers_/80-web-ui (check, check-chat-view, check-access), _verifiers_/87-resizable-panels, _verifiers_/90-web-ui-token, read on 2026-10-22
---

# `rust/crates/heddle-server`

The Rust port of the HTTP server, the token, the live stream and the page it serves.

| | |
|---|---|
| Ported from | `src/server/web.ts`, `src/server/token.ts`, `src/server/html.ts`, `src/server/page.html` (embedded, not rewritten) |
| Judged by | `_verifiers_/80-web-ui` (check, check-chat-view, check-access), `_verifiers_/87-resizable-panels`, `_verifiers_/90-web-ui-token`, through the `heddle` binary |
| Sources | [`src/`](src/INDEX.md) |
| Unit tests | `cargo test --manifest-path rust/Cargo.toml -p heddle-server` |

**State: implemented (server core).** Every module has its body and its unit tests: `token`, `fence`,
`page`, `respond`, `stream`, `runs`, `transcript`, `selection`, `preview`, `services`, and the `server`
builder with the whole `CORE_ROUTES` table driven through `tower::ServiceExt` with a doubled `Harness`.
`cargo test -p heddle-server` is green (121 tests). The door is judged over a real socket as
well as through `tower::ServiceExt`, and `/api/turn` is judged end to end: its session events and
its `done` frame in one streamed response.

The routes answer through the `services` traits, so the crate builds and is tested before the service
crates exist. **Step 7 is not this crate's to finish**: `heddle web` lives in `rust/crates/heddle/`, and
that binary must build a `Harness` over the real session, model, turn and sandbox services and start
`ServerBuilder`. Until it does, `80-web-ui` and `90-web-ui-token` cannot pass through `HEDDLE_BIN`, and
their checks are judged against the TypeScript build.

## Public API

| Module | What it holds |
|---|---|
| `token` | the launch token, the mode-600 signing secret, the authority-bound cookie (byte-compatible with `dist/server/token.js`), `authorize` |
| `fence` | `is_loopback`, `reject_untrusted` (Host and Origin), the cross-site write rule, the bind refusal |
| `page` | the embedded page and its `heddle-page` build marker, the favicon, `page_access`, `token_form_page` |
| `preview` | `html.ts`: the preview allow-lists, `PREVIEW_CSP`, `rewrite_resources`, `/api/html`'s prepared document, where `purify.min.js` is found |
| `respond` | the response shapes every route answers with (`json`, `json_compact`, `text`, `html`, `error`, …), `JsonBody` (the `readJson` rules), `SessionId` / `SessionPath` (the `session-<36>` rule), `canonical_path` (the `canonicalPath` every workspace-bound route applies before `owns`), `inline_content_type`, `file_bytes` |
| `stream` | `EventHub` (every session event and approval question, delivered to each subscriber unbounded), `SseFrame`, `sse_response`, `session_event_forwarder` / `approval_request_forwarder` for the binary's bus listeners |
| `runs` | `RunRegistry` and `TurnGuard`: running counts, the per-turn clock, completion times, stop by `CancellationToken` |
| `transcript` | `transcript_turns` and `attachments_of`: the chat view's fold of a session log, `ChatTurn` |
| `selection` | the endpoint, model and reasoning-level ladders, and the running-turn rule for the `model/request` waterfall |
| `services` | the seam to the harness: `SessionService`, `WorkspaceService`, `ModelService`, `TurnRunner`, `SandboxService`, `ApprovalService`, `GoalService`, `TodoService`, `TeamService`, `AttachmentReader`, `MarkdownRenderer`, `SessionStatsProjector`, collected in `Harness`; `Harness::builder` / `HarnessBuilder` for the binary's composition, `Harness::unavailable` for a boot whose plugins have not loaded (the door answers; every service route refuses, naming the missing service), and `attachment_reader` / `markdown_renderer` / `stats_projector` to wrap a function as one of the optional services |
| `server` | `ServerOptions`, `ServerBuilder` (`mount`, `mount_router`, `session_view`, `into_router`, `start`, which attaches the approval answerer), `AppState`, `Feature`, `SessionView`, `WebServer` (`url`, `announce`, `close`, which detaches the answerer), `DryRunPlan`, `DEFAULT_PORT = 3082`, `CORE_ROUTES` |

### How a feature crate mounts its routes

A ui-lane crate depends on `heddle-server`, implements `server::Feature` (`fn routes(&self) ->
Router<AppState>`), and the binary mounts it with `ServerBuilder::mount`. The fence and the token wrap the
whole router, fallback included, so a mounted route is authenticated without the feature doing anything.

A crate whose handlers keep their own state applies it itself and returns a plain `Router<()>`
(`heddle-web-files`'s `FilesRoutes::router` does this); the binary mounts that with
`ServerBuilder::mount_router`. The server's state is applied before such a router is merged, so both
sides share one router type, and the same door covers it.
Handlers read `State<AppState>` for the `Harness`, the `EventHub` and the `RunRegistry`, keep their own
services inside their `Feature` value, answer through `respond`, and name the session segment `{id}`
(extract it with `respond::SessionPath`). Two routers claiming one method and path fail at startup with
`ServerError::Route`. The ledger is not a separate route: `GET /api/sessions/{id}?view=ledger` dispatches
to a `server::SessionView` registered under `"ledger"`.

### How the harness reaches the server

The routes call the traits in `services`, never a backend crate directly, so this crate builds and is tested
with doubles while those crates are written. Data the server only forwards (events, tree nodes, records,
goal views) is `serde_json::Value`; fields the routes read are typed. The binary implements the traits over
the real services, or this crate gains adapter modules once `heddle-session`, `heddle-workspace` and
`heddle-events` publish their APIs. The bus is bridged in, not depended on: the binary forwards
`session/event` to `EventHub::publish_session_event` and `approval/request` to
`EventHub::publish_approval_request`, and registers `selection::running_turn_selection` as the
`model/request` waterfall listener while the server runs. A stop is a `tokio_util::sync::CancellationToken`
in `TurnRequest`; the agent loop and the HTTP client watch it.

## Route table

Every route of `src/server/web.ts`, with the crate that serves it. Proposed split; the owners named are asked
to confirm or move a row.

| Method and path | Served by | Notes |
|---|---|---|
| `GET /favicon.svg`, `/favicon.ico`, `/healthz` | heddle-server | no token; nothing private |
| `GET /` (handshake, page, token form) | heddle-server | |
| `GET /api/events` | heddle-server | SSE, every session event and approval question |
| `GET /api/status` | heddle-server | the deployment mode and cwd |
| `GET`, `POST /api/sessions` | heddle-server | list with run state; create at a branch |
| `GET /api/sessions/{id}` | heddle-server | the chat view; `?view=<name>` goes to a registered `SessionView` |
| `GET /api/sessions/{id}?view=ledger` | heddle-web-trajectory | as a `SessionView` |
| `GET /api/sessions/{id}/log` | heddle-web-trajectory | the decoded log download |
| `POST /api/sessions/{id}/fork`, `/flags`, `/title`, `/permission`, `/steer`, `/stop` | heddle-server | |
| `POST /api/sessions/{id}/model` | heddle-web-composer | the model switcher |
| `POST /api/folders/session`, `POST /api/turn` | heddle-server | the turn streams its own session's events |
| `GET /api/tree`, `POST /api/workspaces`, `PATCH`/`DELETE /api/workspaces/{id}` | heddle-server | over `WorkspaceService` |
| `POST /api/workspaces/pick` | heddle-web-files | the platform folder picker |
| `GET /api/approvals`, `POST /api/approvals/{id}` | heddle-server | over `ApprovalService` |
| `GET`, `POST /api/goal`, `GET /api/todo`, `GET /api/team` | heddle-server | over the goal, todo and team traits |
| `GET /api/endpoints`, `GET /api/context` | heddle-web-composer | |
| `GET /api/html`, `GET /vendor/purify.js` | heddle-server | `html.ts` is this crate's; the sanitiser is served as `text/javascript` so the preview page can run it |
| `GET /api/raw`, `GET /api/uploads/{leaf}`, `POST /api/uploads`, `GET /api/file`, `POST /api/markdown` | heddle-web-files | use `respond::file_bytes` and `inline_content_type` |

The chat view needs two things other ui-lane crates own, injected through `Harness`: the markdown renderer
(`MarkdownRenderer`, heddle-web-files) for each assistant turn's `html`, and the session statistics
(`SessionStatsProjector`, heddle-web-trajectory) for `stats`. `/api/turn` and the steer route read
attachments through `AttachmentReader` (heddle-web-files). Absent, the field is omitted or the attachments
refused; nothing else changes.

## Port plan

Each step lands with its unit tests and is pushed; the verifier rows say what it should move.

| Step | What | State |
|---|---|---|
| 1 | `token`, `fence`, `page` (marker, token form, access), `respond`: pure rules, ported line for line, with tests against the TypeScript vectors (cookie name, minted value, `read_cookie`, Origin parsing) | done, unit-tested |
| 2 | `stream` (`EventHub`, SSE framing) and `runs` (counts, clock, completion, stop) | done, unit-tested |
| 3 | `server`: the builder, the door middleware, `/healthz`, favicon, `/`, `/api/events`, `/api/status`, `start` and `close` on `--port 0`, and a route conflict reported as `ServerError::Route` at startup; driven in tests through `into_router` with a doubled `Harness` | done, unit-tested (the door's order is tested: fence, handshake, cookie, page, 401; the door is also driven over a real socket, every route in the table is exercised, a wrong method is the TypeScript 404, and a feature claiming a core route is refused at startup) |
| 4 | `transcript`, `selection`, and the session routes: list, chat view, create, `folders/session`, fork, flags, title, permission, steer, stop, and `/api/turn` streaming | done, unit-tested |
| 5 | workspace routes (`/api/tree`, `/api/workspaces`) | done, unit-tested through the trait |
| 6 | approvals, goal, todo, team, `/api/html`, `/vendor/purify.js` | done, unit-tested through the traits |
| 7 | adapters over the real session, workspace and events crates as their APIs land; wiring `heddle web` with the binary's owner | **not started**: the binary crate owns it, and the server has no real `Harness` until those crates land |

**What the binary must do to make the verifiers pass through `HEDDLE_BIN`** (the exact checklist sent
to the binary's owner):

1. Parse `heddle web --host --port --endpoint --max-rounds --session-root --sandbox-root --dry-run
   --json`; `--help` must mention `web`. Map to [`ServerOptions`]: host/port/`max_rounds`/
   `default_endpoint`, `secret_path` (or let [`token::default_secret_path`] read `HEDDLE_HOME`), and
   `asset_roots` `[repository root, working directory]` for `/vendor/purify.js`.
2. `--dry-run --json` prints [`DryRunPlan::for_options`] as one JSON object and exits 0 without binding;
   the human form prints [`DryRunPlan::announce`].
3. Compose the harness with [`Harness::builder`] (or `HarnessBuilder`): the four required services, the
   optional ones the profile loaded, and the process's working directory. For an early `web` bring-up
   before those services exist, [`Harness::unavailable`] serves the door (`/healthz`, the token
   handshake, the page) and refuses every service route honestly; `--dry-run` needs no harness at all. `attachment_reader`,
   `markdown_renderer` and `stats_projector` wrap a function as the optional file/renderer/statistics
   services when the owner crate offers one.
4. `ServerBuilder::new(harness, options)`, take `events()` **before** `start()`, and register
   `stream::session_event_forwarder(hub)` and `stream::approval_request_forwarder(hub)` as the bus's
   `session/event` and `approval/request` listeners; register `running_turn_selection` as the
   `model/request` waterfall listener. Mount each feature crate with `mount`, or a state-applied `Router<()>` with `mount_router`.
5. `start().await`, then print `announce()[0]` — `heddle web: <url>`, the line the verifiers wait for —
   and, when asked, `announce_json()`. On shutdown call `close()`, which ends the open streams.
6. The turn runner receives a `TurnRequest` with a `CancellationToken`; it must publish the session's
   events through the bus (step 4 relays them) and watch the token, which is what `/stop` cancels.

The verifiers named here start the server as `node dist/cli.js` and import `dist/server/web.js` and
`dist/server/token.js`; they judge the Rust binary once the lane integrator has moved them onto `HEDDLE_BIN`.
The cookie format is kept byte-compatible so the TypeScript token module can stay the oracle there.

## Read next

[`../INDEX.md`](../INDEX.md) for the other crates; [`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the parts.
