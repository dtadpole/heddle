---
title: The heddle-todo crate
created: 2026-10-23T00:55:27Z
modified: 2026-10-29T14:28:49Z
version: 0.6.0
description: The Rust port crate for a session's todo list — durable todo/write snapshots, the fold, the model's one tool (todo_write, at DSH parity) and the route the dock reads — its public API and the port plan.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
  - source: src/todo/service.ts, src/todo/tool.ts, src/plugins/todo-tool.ts, the GET /api/todo branch of src/server/web.ts, read 2026-10-22
  - source: the TypeScript port of dsh-tool-todo 0.2.1-rc.2 parity, commits 61594ed7 and 44e3f47f (R-developer-nine-8, -9, -10)
  - source: _verifiers_/80-web-ui/check-todo.mjs
  - source: _verifiers_/50-agentic-loop/check-todo-tool.mjs
---

# `rust/crates/heddle-todo`

The Rust port of the todo list and its one tool, `todo_write`, at parity with DSH's `dsh-tool-todo`: no
`todo_read`, the `todo-tool` row's required `allowParallelInProgress`, and DSH's texts.

| | |
|---|---|
| Ported from | `src/todo/service.ts`, `src/todo/tool.ts`, `src/plugins/todo-tool.ts`, `GET /api/todo` in `src/server/web.ts` |
| Judged by | `_verifiers_/80-web-ui` (`check-todo`) and `_verifiers_/50-agentic-loop` (`check-todo-tool`), through the `heddle` binary; unit tests port `test/todo.test.ts` |
| Sources | [`src/`](src/INDEX.md) |
| Owner | seat `developer-six`; merges through `integrator-one` |

## Articles

| Article | What it holds |
|---|---|
| [`public-api.md`](public-api.md) | Every public item of the crate, what it is, and the modules that hold them. |
| [`seats.md`](seats.md) | What each dependent or providing seat supplies, and what it gets from this crate. |
| [`port-plan.md`](port-plan.md) | The steps of the port and what each landed. |

## Read next

[`../INDEX.md`](../INDEX.md) for the other crates; [`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the parts.
