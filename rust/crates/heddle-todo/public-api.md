---
title: The heddle-todo public API
created: 2026-10-23T00:55:27Z
modified: 2026-10-24T06:19:40Z
level: L1
version: 1.0.0
description: Every public item of the crate, what it is, and the modules that hold them.
status: unverified
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
  - source: src/todo/service.ts, src/todo/tool.ts, src/plugins/todo-tool.ts, the GET /api/todo branch of src/server/web.ts, read 2026-10-22
  - source: _verifiers_/80-web-ui/check-todo.mjs
---

# The heddle-todo public API

| Item | What it is |
|---|---|
| `TodoStatus`, `TodoItem`, `TodoCounts`, `TodoView`, `TodoWrite` | the shapes, serialized with the TypeScript keys (`inProgress`, `updatedAt`) |
| `validate_todos`, `counts_of`, `decode_todo_write`, `fold_todos`, `todo_write_event` | the pure part: strict validation, the last-write-wins fold, the `todo/write` body `{type, version, todos, updatedAt}` |
| `TodoService`, `TodoConfig` | `get`, `write` (whole-list replacement), `clear`; `allowParallelInProgress` off by default |
| `TodoError`, `TodoErrorCode` | `TODO_INVALID_LIST`, `TODO_INVALID_LOG`, or a log failure |
| `SessionLog`, `LogError`, `Clock`, `SystemClock`, `iso_timestamp` | the ports: `open`/`read`/`append` over JSON events, and a `Date.toISOString` clock |
| `tool::{todo_tool_specs, run_todo_write, run_todo_read}` | the two tools as specs and functions over std and serde types; the boot wraps them as `heddle-tools` registry tools (the session from the call's context, the answer read as a `ToolResult`), so this crate needs no tools dependency |
| `http::get_todo` | `GET /api/todo` as status and exact body bytes (503 / 400 / 404 / 200 `{session, todo}`) |

## Read next

[`INDEX.md`](INDEX.md) for the crate.
