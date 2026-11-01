---
title: Todo
version: 1.1.0
description: A session's task list — durable todo/write snapshots, the fold, the model's one tool, and the panel that renders it.
grounded_in:
  - source: dsh-0.2.0-rc.2
  - source: dsh-0.2.1-rc.2 dsh-tool-todo, via _designs_/dsh-parity/goals-todo-spec.md section C (R-developer-nine-8, -9, -10)
  - source: dsh-tool-todo read on 2026-10-18, recorded in _context_/dsh-mechanisms/dsh-todo.md
  - source: human-authored
---

# `todo`

A small, durable task list a session plans multi-step work with, modelled on DSH's `dsh-tool-todo` — the
reading with evidence is [`_context_/dsh-mechanisms/dsh-todo.md`](../../_context_/dsh-mechanisms/dsh-todo.md).
Two files:

| File | What it is |
|---|---|
| [`service.ts`](service.ts) | the event-sourced list: one `todo/write` per write carrying the **whole list**, last-write-wins fold, strict decoding, validation of trimmed non-empty unique content and, under the caller's policy, at most one `in_progress`, with DSH's refusal sentences; `TodoService.get/write/clear` |
| [`tool.ts`](tool.ts) | the model's one verb, DSH's `todo_write`: whole-list replacement answered with the counts, DSH's description and parameter texts, and the required `allowParallelInProgress` setting (`TodoToolConfig`) that picks the description's active-status clause and, only when false, refuses a second item in progress |

The list is rendered in the Web UI's input dock (the panel next to the goal bar) and read through
`GET /api/todo?session=`.

## One divergence from DSH, recorded

DSH resets its list on `turn/start`, because its list is a **per-turn plan**. This project's durable unit is
the session, and a list that disappears between turns is not a list a person can read, so the list persists
until it is replaced (or written empty, which hides it). The cost: a stale list can linger until the model
replaces it.

## No read tool, as in DSH

There is no `todo_read` (R-developer-nine-10). The model knows its list from its own earlier `todo_write`
arguments in its history; the tool's answer carries only counts. The durable list serves people: the dock and
`GET /api/todo` read the service, not a tool.

## The setting

`allowParallelInProgress` is a **required** boolean of the `todo-tool` row with no default, so a row without it
fails to load (R-developer-nine-9). True selects "While work remains, keep the todos being worked on
`in_progress`, several only when work runs in parallel."; false selects "While work remains, keep exactly one
todo `in_progress`." and refuses a list with more than one item in progress. The shipped profile sets it true,
as every DSH preset ships.

## Refusals

DSH's sentences, under this project's codes. `TODO_INVALID_LIST`: ``invalid todo: `content` must be a
non-empty string`` (content trimmed first), `invalid todos: duplicate content "<content>"` and `invalid todos:
at most one task may be in_progress (got <n>)`. `TODO_TOOL_NO_SESSION`: `todo_write requires an owning agent
session`. Validation runs before the session check. A non-array, a non-object item, an unknown key or an
unknown status, which DSH's registry refuses at its schema boundary, keep this project's own texts.

## Tests

- [`../../test/todo.test.ts`](../../test/todo.test.ts) — the fold, last-write-wins, strict decoding,
  validation refusals and their DSH sentences, durability across turns and a reopened store, the one tool
  (both description clauses, the parallel refusal only when false, the missing-setting load failure, no
  `todo_read`).
- [`../../_verifiers_/50-agentic-loop/check-todo-tool.mjs`](../../_verifiers_/50-agentic-loop/check-todo-tool.mjs)
  — the tool through `heddle web` and the shipped profile: two in progress accepted, DSH's refusals, no
  `todo_read` offered or callable, the result sentence.
- the part 9 browser check — the panel appears and updates live from a scripted `todo_write`.

## Read next

[`../INDEX.md`](../INDEX.md) for the source tree, and
[`../../_context_/dsh-mechanisms/dsh-todo.md`](../../_context_/dsh-mechanisms/dsh-todo.md) for the reference.
