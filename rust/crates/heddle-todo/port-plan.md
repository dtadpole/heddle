---
title: The heddle-todo port plan
created: 2026-10-23T00:55:27Z
modified: 2026-10-29T14:28:49Z
level: L1
version: 1.1.0
description: The steps of the port and what each landed.
status: unverified
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
  - source: src/todo/service.ts, src/todo/tool.ts, src/plugins/todo-tool.ts, the GET /api/todo branch of src/server/web.ts, read 2026-10-22
  - source: the TypeScript port of dsh-tool-todo 0.2.1-rc.2 parity, commits 61594ed7 and 44e3f47f (R-developer-nine-8, -9, -10)
  - source: _verifiers_/80-web-ui/check-todo.mjs
---

# The heddle-todo port plan

| Step | What | State |
|---|---|---|
| 1 | Public API, docs | landed |
| 2 | `iso_timestamp`, validation, counts, decode, fold, event body, the service — porting every case of `test/todo.test.ts` | landed |
| 3 | The tools and the route, with their answers compared byte for byte with the TypeScript build's | landed |
| 4 | Swap the `SessionLog` double for `heddle-session`'s store (`SessionLog` is implemented for `SessionStore`) and the mirrors for `heddle-tools`' types | landed: the store directly, the tool types through the boot's wrapper (settled, so the shapes stay this crate's) |
| 5 | `check-todo` through `HEDDLE_BIN` | with the server and the binary |
| 6 | DSH parity of the tool (R-developer-nine-8, -9, -10), from the TypeScript port: `todo_read` dropped, the `todo-tool` row's required `allowParallelInProgress`, DSH's description and refusal sentences, validation before the session check; `check-todo-tool` through `HEDDLE_BIN` | landed |

## Read next

[`INDEX.md`](INDEX.md) for the crate.
