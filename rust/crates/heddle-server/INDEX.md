---
title: The heddle-server crate
version: 0.2.0
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

**State: contract.** The public API is in place with `todo!()` bodies; the port plan below says what is
implemented next. Build against the API with test doubles until the bodies land.

## Public API

| Module | What it holds |
|---|---|
| `token` | the launch token, the mode-600 signing secret, the authority-bound cookie (byte-compatible with `dist/server/token.js`), `authorize` |
| `fence` | `is_loopback`, `reject_untrusted` (Host and Origin), the cross-site write rule, the bind refusal |
| `page` | the embedded page and its `heddle-page` build marker, the favicon, `page_access`, `token_form_page` |
| `preview` | `html.ts`: the preview allow-lists, `PREVIEW_CSP`, `rewrite_resources`, `/api/html`'s prepared document, where `purify.min.js` is found |
| `respond` | the response shapes every route answers with (`json`, `json_compact`, `text`, `html`, `error`, …), `JsonBody` (the `readJson` rules), `SessionId` / `SessionPath` (the `session-<36>` rule), `inline_content_type`, `file_bytes` |
| `stream` | `EventHub` (every session event and approval question, delivered to each subscriber unbounded), `SseFrame`, `sse_response` |
| `runs` | `RunRegistry` and `TurnGuard`: running counts, the per-turn clock, completion times, stop by `CancellationToken` |
| `transcript` | `transcript_turns` and `attachments_of`: the chat view's fold of a session log, `ChatTurn` |
| `selection` | the endpoint, model and reasoning-level ladders, and the running-turn rule for the `model/request` waterfall |
| `services` | the seam to the harness: `SessionService`, `WorkspaceService`, `ModelService`, `TurnRunner`, `SandboxService`, `ApprovalService`, `GoalService`, `TodoService`, `TeamService`, `AttachmentReader`, `MarkdownRenderer`, `SessionStatsProjector`, collected in `Harness` |
| `server` | `ServerOptions`, `ServerBuilder` (`mount`, `session_view`, `into_router`, `start`), `AppState`, `Feature`, `SessionView`, `WebServer` (`url`, `announce`, `close`), `DryRunPlan`, `DEFAULT_PORT = 3082`, `CORE_ROUTES` |

### How a feature crate mounts its routes

A ui-lane crate depends on `heddle-server`, implements `server::Feature` (`fn routes(&self) ->
Router<AppState>`), and the binary mounts it with `ServerBuilder::mount`. The fence and the token wrap the
whole router, fallback included, so a mounted route is authenticated without the feature doing anything.
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
| `GET /api/html`, `GET /vendor/purify.js` | heddle-server | `html.ts` is this crate's |
| `GET /api/raw`, `GET /api/uploads/{leaf}`, `POST /api/uploads`, `GET /api/file`, `POST /api/markdown` | heddle-web-files | use `respond::file_bytes` and `inline_content_type` |

The chat view needs two things other ui-lane crates own, injected through `Harness`: the markdown renderer
(`MarkdownRenderer`, heddle-web-files) for each assistant turn's `html`, and the session statistics
(`SessionStatsProjector`, heddle-web-trajectory) for `stats`. `/api/turn` and the steer route read
attachments through `AttachmentReader` (heddle-web-files). Absent, the field is omitted or the attachments
refused; nothing else changes.

## Port plan

Each step lands with its unit tests and is pushed; the verifier rows say what it should move.

| Step | What | Judged by |
|---|---|---|
| 1 | `token`, `fence`, `page` (marker, token form, access), `respond`: pure rules, ported line for line, with tests against the TypeScript vectors (cookie name, minted value, `read_cookie`, Origin parsing) | unit tests |
| 2 | `stream` (`EventHub`, SSE framing) and `runs` (counts, clock, completion, stop) | unit tests |
| 3 | `server`: the builder, the door middleware, `/healthz`, favicon, `/`, `/api/events`, `/api/status`, `start` and `close` on `--port 0`; driven in tests through `into_router` with a doubled `Harness` | unit tests; `90-web-ui-token` once the binary wires `heddle web` |
| 4 | `transcript`, `selection`, and the session routes: list, chat view, create, `folders/session`, fork, flags, title, permission, steer, stop, and `/api/turn` streaming | `80-web-ui` check and check-access, `90-web-ui-token` |
| 5 | workspace routes (`/api/tree`, `/api/workspaces`) | `87-resizable-panels`, `80-web-ui` check-chat-view |
| 6 | approvals, goal, todo, team, `/api/html`, `/vendor/purify.js` | the 80-web-ui checks of those owners |
| 7 | adapters over the real session, workspace and events crates as their APIs land; wiring `heddle web` with the binary's owner | all of the above through `HEDDLE_BIN` |

The verifiers named here start the server as `node dist/cli.js` and import `dist/server/web.js` and
`dist/server/token.js`; they judge the Rust binary once the lane integrator has moved them onto `HEDDLE_BIN`.
The cookie format is kept byte-compatible so the TypeScript token module can stay the oracle there.

## Read next

[`../INDEX.md`](../INDEX.md) for the other crates; [`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the parts.
