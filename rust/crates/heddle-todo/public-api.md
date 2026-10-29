---
title: The heddle-todo public API
created: 2026-10-23T00:55:27Z
modified: 2026-10-29T14:28:49Z
level: L1
version: 1.1.0
description: Every public item of the crate, what it is, and the modules that hold them.
status: unverified
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
  - source: src/todo/service.ts, src/todo/tool.ts, src/plugins/todo-tool.ts, the GET /api/todo branch of src/server/web.ts, read 2026-10-22
  - source: the TypeScript port of dsh-tool-todo 0.2.1-rc.2 parity, commits 61594ed7 and 44e3f47f (R-developer-nine-8, -9, -10)
  - source: _verifiers_/80-web-ui/check-todo.mjs
---

# The heddle-todo public API

| Item | What it is |
|---|---|
| `TodoStatus`, `TodoItem`, `TodoCounts`, `TodoView`, `TodoWrite` | the shapes, serialized with the TypeScript keys (`inProgress`, `updatedAt`) |
| `validate_todos`, `counts_of`, `decode_todo_write`, `fold_todos`, `todo_write_event` | the pure part: strict validation, the last-write-wins fold, the `todo/write` body `{type, version, todos, updatedAt}` |
| `TodoService`, `TodoConfig` | `get`, `write` (whole-list replacement under the service's policy), `write_with_policy` (under the caller's), `clear`; the `todo` row's `allowParallelInProgress` is the fallback policy, off by default |
| `TodoError`, `TodoErrorCode`, `TODO_EMPTY_CONTENT_MESSAGE` | `TODO_INVALID_LIST`, `TODO_INVALID_LOG`, or a log failure; the content, duplicate and in-progress refusals are DSH's sentences |
| `SessionLog`, `LogError`, `Clock`, `SystemClock`, `iso_timestamp` | the ports: `open`/`read`/`append` over JSON events, and a `Date.toISOString` clock |
| `tool::{todo_tool_specs, run_todo_write, describe_todo_write}` | `todo_write` alone (no `todo_read`, as in DSH) as a spec and a function over std and serde types, validation before the session check; the boot wraps it as a `heddle-tools` registry tool (the session from the call's context, the answer read as a `ToolResult`), so this crate needs no tools dependency |
| `tool::{TodoToolConfig, TodoToolConfigError, todo_tool_config_schema, TODO_NO_SESSION_MESSAGE}` | the `todo-tool` row's one setting, `allowParallelInProgress`, required with no default (`from_row` refuses a row without a boolean), and its JSON schema for `config --validate`; the setting picks the description's clause and, only when false, refuses a second item in progress |
| `http::get_todo` | `GET /api/todo` as status and exact body bytes (503 / 400 / 404 / 200 `{session, todo}`) |

## Read next

[`INDEX.md`](INDEX.md) for the crate.
