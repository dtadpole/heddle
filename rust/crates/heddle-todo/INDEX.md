---
title: The heddle-todo crate
version: 0.2.0
description: The Rust port crate for a session's todo list — durable todo/write snapshots, the fold, the model's two tools and the route the dock reads — its public API and the port plan.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
  - source: src/todo/service.ts, src/todo/tool.ts, src/plugins/todo-tool.ts, the GET /api/todo branch of src/server/web.ts, read 2026-10-22
  - source: _verifiers_/80-web-ui/check-todo.mjs
---

# `rust/crates/heddle-todo`

The Rust port of the todo list and its tools.

| | |
|---|---|
| Ported from | `src/todo/service.ts`, `src/todo/tool.ts`, `src/plugins/todo-tool.ts`, `GET /api/todo` in `src/server/web.ts` |
| Judged by | `_verifiers_/80-web-ui` (`check-todo`), through the `heddle` binary; unit tests port `test/todo.test.ts` |
| Sources | [`src/`](src/INDEX.md) |
| Owner | seat `developer-six`; merges through `integrator-one` |

## Public API

| Item | What it is |
|---|---|
| `TodoStatus`, `TodoItem`, `TodoCounts`, `TodoView`, `TodoWrite` | the shapes, serialized with the TypeScript keys (`inProgress`, `updatedAt`) |
| `validate_todos`, `counts_of`, `decode_todo_write`, `fold_todos`, `todo_write_event` | the pure part: strict validation, the last-write-wins fold, the `todo/write` body `{type, version, todos, updatedAt}` |
| `TodoService`, `TodoConfig` | `get`, `write` (whole-list replacement), `clear`; `allowParallelInProgress` off by default |
| `TodoError`, `TodoErrorCode` | `TODO_INVALID_LIST`, `TODO_INVALID_LOG`, or a log failure |
| `SessionLog`, `LogError`, `Clock`, `SystemClock`, `iso_timestamp` | the ports: `open`/`read`/`append` over JSON events, and a `Date.toISOString` clock |
| `tool::{todo_tool_specs, run_todo_write, run_todo_read}` | the two tools as specs and functions; `ToolSpec`/`ToolAnswer` mirror `heddle-tools`' shapes until its API lands |
| `http::get_todo` | `GET /api/todo` as status and exact body bytes (503 / 400 / 404 / 200 `{session, todo}`) |

## What the other seats provide, and what they get

- **developer-eight (`heddle-session`)**: a store that satisfies `SessionLog` — `open(id) -> canonical id`,
  `read(id) -> events`, `append(id, body) -> event` with `seq` and `at` put in front of the body's keys. When
  its API lands, the `impl SessionLog for` its store goes in this crate and the boot passes the store.
- **developer-five (`heddle-tools`)**: the tool trait; `todo_write` and `todo_read` are then registered by a
  `todo-tool` row, separate from the `todo` row, so a profile can keep the list without the verbs.
- **developer-ten (`heddle-server`)**: mounts `http::get_todo` at `GET /api/todo`, and forwards `session/event`
  on the live stream, which is what makes the dock update without a reload (`todo/write` events).
- **developer-two (`heddle`)**: builds the service from the `todo` row's config.

## Port plan

| Step | What | State |
|---|---|---|
| 1 | Public API, docs | landed |
| 2 | `iso_timestamp`, validation, counts, decode, fold, event body, the service — porting every case of `test/todo.test.ts` | landed |
| 3 | The tools and the route, with their answers compared byte for byte with the TypeScript build's | landed |
| 4 | Swap the `SessionLog` double for `heddle-session`'s store (`SessionLog` is implemented for `SessionStore`) and the mirrors for `heddle-tools`' types | the store: landed; the tool types: when `heddle-tools`' `Tool` stops using its provisional mirrors |
| 5 | `check-todo` through `HEDDLE_BIN` | with the server and the binary |

## Read next

[`../INDEX.md`](../INDEX.md) for the other crates; [`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the parts.
