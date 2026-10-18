---
title: Skills
version: 1.1.0
description: How to do a recurring job in this project — a procedure with its instruments, its checklist and the mistakes already made, so the next session starts from what the last one learned.
grounded_in:
  - source: owner statement 2026-10-17 that a thorough UI comparison should live in a skill for the heddle project rather than in one session's memory
  - source: the reflection type vocabulary, where a skill definition is a named procedure with its evidence
---

# `_skills_`

Instance of the `_skills_` type: **skill definitions**. A convention says what must be true; a skill says
**how to do a thing** — the instruments to drive, the checklist to walk, and the mistakes that have already
been paid for.

## Shape: one instance per procedure

| Skill | For |
|---|---|
| [`ui-parity-audit`](ui-parity-audit/INDEX.md) | matching this UI against a reference implementation (the running DSH at `127.0.0.1:8080`) without missing the same thing twice: a coverage matrix, a DOM-derived inventory, content stress, occlusion checks and the ledger of every miss |
| [`full-loop-goal`](full-loop-goal/INDEX.md) | turning a large job into a goal that runs research (measure, then brainstorm) → understand (then step back) → plan → implement → verify → fix for a stated number of cycles |

## What belongs here

- A procedure someone must **repeat** — not a one-off decision (that is a convention) and not a fact about
  the machine (that is `_context_`).
- The **instruments** it needs, named precisely enough to run without rediscovering them.
- The **checklist** it walks, because a skill that relies on memory of what to look at is the thing this
  folder exists to replace.
- The **lessons**: each real miss, what it cost, and the rule that now prevents it.

## Read next

[`ui-parity-audit`](ui-parity-audit/INDEX.md) first, because it is the one the owner asked for;
[`../AGENTS.md`](../AGENTS.md) for the rules that bind this repository.
