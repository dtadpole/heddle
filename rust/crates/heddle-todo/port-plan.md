---
title: The heddle-todo port plan
created: 2026-10-23T00:55:27Z
modified: 2026-10-24T06:19:40Z
level: L1
version: 1.0.0
description: The steps of the port and what each landed.
status: unverified
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
  - source: src/todo/service.ts, src/todo/tool.ts, src/plugins/todo-tool.ts, the GET /api/todo branch of src/server/web.ts, read 2026-10-22
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

## Read next

[`INDEX.md`](INDEX.md) for the crate.
