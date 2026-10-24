---
title: The heddle-todo crate
created: 2026-10-23T00:55:27Z
modified: 2026-10-24T06:19:40Z
version: 0.5.0
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

## Articles

| Article | What it holds |
|---|---|
| [`public-api.md`](public-api.md) | Every public item of the crate, what it is, and the modules that hold them. |
| [`seats.md`](seats.md) | What each dependent or providing seat supplies, and what it gets from this crate. |
| [`port-plan.md`](port-plan.md) | The steps of the port and what each landed. |

## Read next

[`../INDEX.md`](../INDEX.md) for the other crates; [`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the parts.
