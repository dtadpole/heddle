---
title: Todo
version: 1.0.0
description: A session's task list — durable todo/write snapshots, the fold, the model's two tools, and the panel that renders it.
grounded_in:
  - source: dsh-0.2.0-rc.2
  - source: dsh-tool-todo read on 2026-10-18, recorded in _context_/dsh-mechanisms/dsh-todo.md
  - source: human-authored
---

# `todo`

A small, durable task list a session plans multi-step work with, modelled on DSH's `dsh-tool-todo` — the
reading with evidence is [`_context_/dsh-mechanisms/dsh-todo.md`](../../_context_/dsh-mechanisms/dsh-todo.md).
Two files:

| File | What it is |
|---|---|
| [`service.ts`](service.ts) | the event-sourced list: one `todo/write` per write carrying the **whole list**, last-write-wins fold, strict decoding, validation of trimmed non-empty unique content and at most one `in_progress`; `TodoService.get/write/clear` |
| [`tool.ts`](tool.ts) | the model's verbs: `todo_write` (whole-list replacement, returns the list and its counts) and `todo_read` (the durable list, for a session resumed after a restart) |

The list is rendered in the Web UI's input dock (the panel next to the goal bar) and read through
`GET /api/todo?session=`.

## One divergence from DSH, recorded

DSH resets its list on `turn/start`, because its list is a **per-turn plan**. This project's durable unit is
the session, and a list that disappears between turns is not a list a person can read, so the list persists
until it is replaced (or written empty, which hides it). The cost — a stale list can linger until the model
replaces it — is the reason `todo_read` exists.

## Tests

- [`../../test/todo.test.ts`](../../test/todo.test.ts) — the fold, last-write-wins, strict decoding,
  validation refusals, durability across turns and a reopened store, and both tools.
- the part 9 browser check — the panel appears and updates live from a scripted `todo_write`.

## Read next

[`../INDEX.md`](../INDEX.md) for the source tree, and
[`../../_context_/dsh-mechanisms/dsh-todo.md`](../../_context_/dsh-mechanisms/dsh-todo.md) for the reference.
