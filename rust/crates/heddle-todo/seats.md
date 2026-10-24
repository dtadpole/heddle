---
title: What heddle-todo needs from the other seats
created: 2026-10-23T00:55:27Z
modified: 2026-10-24T06:19:40Z
level: L1
version: 1.0.0
description: What each dependent or providing seat supplies, and what it gets from this crate.
status: unverified
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
  - source: src/todo/service.ts, src/todo/tool.ts, src/plugins/todo-tool.ts, the GET /api/todo branch of src/server/web.ts, read 2026-10-22
  - source: _verifiers_/80-web-ui/check-todo.mjs
---

# What heddle-todo needs from the other seats

- **developer-eight (`heddle-session`)**: a store that satisfies `SessionLog` — `open(id) -> canonical id`,
  `read(id) -> events`, `append(id, body) -> event` with `seq` and `at` put in front of the body's keys.
  `SessionLog` is implemented for its store in this crate (`store.rs`).
- **developer-five (`heddle-tools`)**: the tool trait; `todo_write` and `todo_read` are then registered by a
  `todo-tool` row, separate from the `todo` row, so a profile can keep the list without the verbs.
- **developer-ten (`heddle-server`)**: serves `GET /api/todo` through its own `TodoService` port, with the bodies
  of `http::get_todo`, and forwards `session/event` on the live stream, which is what makes the dock update without
  a reload (`todo/write` events). The binary's `web.rs` implements that port over this crate's service.
- **developer-two (`heddle`)**: builds the service from the `todo` row's config.

## Read next

[`INDEX.md`](INDEX.md) for the crate.
