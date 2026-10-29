---
title: The heddle-commands sources
created: 2026-10-29T12:21:02Z
modified: 2026-10-29T15:20:00Z
version: 0.3.0
description: The sources of the heddle-commands crate, with unit tests beside the code.
grounded_in:
  - source: src/commands/registry.ts, src/commands/builtins.ts, src/commands/http.ts, src/commands/service.ts, read 2026-10-29
  - source: src/commands/goal.ts, test/commands-goal.test.ts (commit 3729bdf6)
  - source: test/commands.test.ts
---

# `rust/crates/heddle-commands/src`

The sources of the crate, with unit tests in `#[cfg(test)]` modules beside the code.

| File | What it is |
|---|---|
| [`lib.rs`](lib.rs) | the crate root, its documentation, `ROUTES` and `router` |
| [`registry.rs`](registry.rs) | `CommandRegistry`, `parse_command_line`, the two event names, the result shapes, `CommandLog`, `CommandError` (the attachments refusal; ports `registry.ts`) |
| [`builtins.rs`](builtins.rs) | `/compact`, `/feedback`, `/permission`, `/export`, each over the smallest host it needs (ports `builtins.ts`) |
| [`goal.rs`](goal.rs) | `/goal`: DSH's parse, goal card and sentences over `GoalHost`, the attachment follow-up (ports `goal.ts`, developer-nine's, D-059; its tests port `test/commands-goal.test.ts`) |
| [`service.rs`](service.rs) | `Commands` and `CommandServices`: the built-ins wired to the session, goal, context, model and sandbox facts; a line's attachments read from the upload directory as message parts; the anonymous feedback id (ports `service.ts`) |
| [`routes.rs`](routes.rs) | `GET /commands/menu.js` (the embedded `src/commands/menu.js`), `GET /api/commands`, `POST /api/sessions/{id}/commands`, the pretty JSON answer (ports `http.ts`) |
| [`text.rs`](text.rs) | the JavaScript behaviours reproduced (`trim`, `localeCompare` for names, `encodeURIComponent`, the session-id shape) and the random ids |
| [`test_support.rs`](test_support.rs) | a real session store in a temporary folder, an upload directory beside it, and the in-process router call (`#[cfg(test)]` only) |

## Read next

[`../INDEX.md`](../INDEX.md) for what the crate ports, what judges it, and how it is mounted.
