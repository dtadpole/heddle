---
title: The heddle-commands crate
created: 2026-10-29T12:21:02Z
modified: 2026-10-29T15:15:00Z
version: 0.2.0
description: The Rust port crate for the host's slash commands — the registry, the line parser, the five built-in commands (with DSH's /goal) and the two routes the composer's slash menu uses — its public API, what it needs from other crates, and how it is mounted.
grounded_in:
  - source: src/commands/registry.ts, src/commands/builtins.ts, src/commands/http.ts, src/commands/service.ts and src/commands/INDEX.md, read 2026-10-29
  - source: src/commands/goal.ts and test/commands-goal.test.ts (commit 3729bdf6), read 2026-10-29
  - source: _projects_/heddle/_designs_/dsh-parity/goals-todo-spec.md section B1
  - source: test/commands.test.ts
  - source: _verifiers_/80-web-ui/check-slash-commands.mjs
---

# `rust/crates/heddle-commands`

The Rust port of the slash-command layer, modelled (through the TypeScript build) on DSH's `dsh-commands`. A line
that opens with `/name` and names a registered command runs **on the host**: it never becomes a prompt, and the
session log records a `command/run` before the handler and a `command/done` after it, both log-only (no place on
the model's surface). A line that names no command is left alone — nothing is written — and the page sends it as an
ordinary prompt, which is how `/skillname` and a typo like `/compcat` still reach the model.

| | |
|---|---|
| Ported from | `src/commands/` (`registry.ts`, `builtins.ts`, `goal.ts`, `http.ts`, `service.ts`) |
| Judged by | `_verifiers_/80-web-ui/check-slash-commands.mjs`, through the `heddle` binary (`HEDDLE_BIN`) |
| Sources | [`src/`](src/INDEX.md) |
| Status | **mounted by `heddle web`** (`rust/crates/heddle/src/web.rs`, `commands_host`); 66 unit tests port `test/commands.test.ts` and `test/commands-goal.test.ts` case by case; through a debug `HEDDLE_BIN` the check's four server checks pass, the browser check is judged separately under the browser lock |
| Owner | `developer-three` (D-057), with the TypeScript layer; what `/goal` means (`src/goal.rs`) is `developer-nine`'s (D-059), landed through this crate and credited under D-055 |

## Routes

| Route | Answer |
|---|---|
| `GET /commands/menu.js` | `200 text/javascript; charset=utf-8` — the slash menu the page imports: `src/commands/menu.js` embedded at compile time (`include_str!`, as `heddle-server` embeds `page.html`), so a rebuild picks up an edit |
| `GET /api/commands` | `200 {"commands": [{name, label, description, section, input?}, …]}`, sorted as `localeCompare` sorts |
| `POST /api/sessions/{id}/commands` `{line}` | `200 {"matched": false}` (nothing written) or `200 {"matched": true, commandId, name, kind, text?, action?, seq}` |
| … malformed id / no such session | `400 not a session id` / `404 no session <id>` |
| … body over 64 KiB + 1 KiB | `413 a command line is at most 65536 bytes` |
| … body not a JSON object with a string `line` | `400 the body must be JSON with a string "line"` |

Every JSON answer, refusals included, is `JSON.stringify(value, null, 2)` plus a newline, `application/json`,
`cache-control: no-store` — `http.ts`'s single `json` helper. A handler's refusal is `kind: "error"` with status
200: the command ran and its row says so. No path is a server route (`heddle-server`'s `CORE_ROUTES`) or another
feature crate's, and the session segment is named `{id}` as the server's router requires.

A reload draws a command's row from the session's history: `heddle-server`'s transcript fold
(`src/transcript.rs`, developer-ten) turns `command/run` + `command/done` into a `command` turn, as
`transcriptTurns` in `src/server/web.ts` does.

## The built-in commands

| Command | Input | Section | What it does |
|---|---|---|---|
| `/compact` | none | Commands | the context service's forced reduction (`prepare(…, force: true)`), measured before and after: "Compacted N history items (~T tokens)." or "No compactable history yet." |
| `/goal` | `[<objective>\|clear\|edit <objective>\|pause\|resume]`, attachments allowed | Add | DSH's `dsh-command-goal`, word for word: the parse (whole-input `clear`/`pause`/`resume` in any case, `edit <objective>`, anything else a create), the goal card (title, `Status`, `Blocker` when blocked, `Objective`, `Rounds`, `Activation`, a per-state `Commands` hint), "Goal created/updated/paused/resumed", and every goal-service refusal as "The goal command is not valid for the current state. Run /goal to view available commands." |
| `/feedback` | `<text>` | Add | a `feedback/record` `{text, anonymousUser}` event; the id is a UUID kept in `<heddle home>/feedback-user-id` (mode 600); the text is kept out of `command/run` |
| `/permission` | `<preset>` | Commands | the session's sandbox mode; widening to `danger-full-access` is refused and left to the access chip's risk gate |
| `/export` | none | Commands | `action: {kind: "download", href: "/api/sessions/<id>/log"}`, the same bytes as Download log |

## Public API

| Item | What it is |
|---|---|
| `CommandRegistry` (`register` → `Disposer`, `has`, `list`, `execute`) | names unique and `[a-z][a-z0-9_-]*`; run ids `cmd-<8 hex>-<n>`; `execute` answers `None` for a line that is not a registered command |
| `parse_command_line`, `is_command_name`, `default_label` | the TypeScript `COMMAND_LINE` and `COMMAND_NAME` rules, without a regex crate |
| `CommandDefinition` (`new`, `sync`, `label`, `section`, `input`, `record_input`), `CommandResult`, `CommandAction`, `CommandDescriptor`, `CommandExecution`, `CommandLog` | the shapes; a handler's `Err` (or panic) is a result of kind `error` |
| `compact_command`, `feedback_command`, `permission_command`, `export_command` | the built-ins over `CompactionHost`, `CommandLog` + `AnonymousUser`, `PermissionHost` |
| `goal_command(GoalHost, Option<GoalFollowupSink>)`, `execute_goal_command`, `parse_goal_command`, `render_goal`, `command_hint`, `goal_attachment_followup`, `GoalHostError`, `GOAL_USAGE`, `GOAL_STATE_ERROR`, … | `/goal` (`goal.rs`): the handler that already takes attachments, the parse, the card, and the refusal split (`Refused` → the one sentence, `Failed` → the run's error) |
| `Commands` (`new(CommandServices)`, `with_registry`, `open`, `execute`), `CommandServices` | the host the routes read, wired to the real services |
| `router(Arc<Commands>) -> axum::Router`, `ROUTES`, `MAX_COMMAND_LINE` | the mount |

## What it needs from other crates

| From | What |
|---|---|
| `heddle-session` | `SessionService` (`open`, `meta`, `events`, `effective_mode`, `set_mode`) and the store's `append` |
| `heddle-goal` | `GoalService` (`get`, `create`, `edit`, `pause`, `resume`, `clear`), `GoalView`, `GoalRef`, `GoalError`; absent → the run's error "the goal service is not loaded in this profile" |
| `heddle-context` | `ContextService<SessionStore>::prepare` and `measure`; absent → "Compaction is unavailable because the context service is not loaded." |
| `heddle-llm` | `ModelService::default_endpoint(None)` when the session records no endpoint; none at all → "Compaction is unavailable because no model endpoint is configured to summarise with." `ContentPart` and `Message` for `/goal`'s attachment follow-up |
| `heddle-sandbox` | `SandboxMode` (the vocabulary and its rank); the binary passes the deployment's mode as the default |

No third-party dependency beyond the workspace's `axum`, `futures`, `serde` and `serde_json`; random ids come
from the standard library's randomly keyed hasher.

## Mounting

`rust/crates/heddle/src/web.rs` builds `Commands` from `boot.services` (`session`, `goal`, `context`, `model`,
the `sandbox` service's mode, else `workspace-write`) in `commands_host`, and `page_routers` pushes
`heddle_commands::router(..)` behind the server's door.

## Deviations from the TypeScript build

- A path whose id segment holds a `/` never reaches the route (axum matches one segment); the server answers its
  `404` where `http.ts` would answer `400 not a session id`.
- A session-log append that fails is answered `500 {"error": …}` by the route, where `http.ts` throws to the
  server's catch-all.
- The ids (`cmd-<8 hex>`, the anonymous UUID) are random but not cryptographic: neither is a secret.
- As in the TypeScript build, `/goal`'s attachments do not travel yet: `CommandContext` carries none and the route reads
  only `line`, so the registered handler runs with none and `Commands::new` passes no follow-up sink. The handler
  (`execute_goal_command`) already takes them — the TODO for developer-three is in `goal.rs`.

## Read next

[`src/INDEX.md`](src/INDEX.md) for the files; [`../heddle-goal/`](../heddle-goal/INDEX.md) and
[`../heddle-context/`](../heddle-context/INDEX.md) for the services two commands drive.
