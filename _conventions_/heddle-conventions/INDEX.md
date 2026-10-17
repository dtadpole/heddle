---
title: Heddle conventions
version: 1.0.0
description: The rules specific to Heddle, each with the evidence that made it a rule and the tests that judge it.
grounded_in:
  - source: human-authored
---

# `heddle-conventions`

The rules that are Heddle's own rather than borrowed from `reflection`. Each article states **one rule**, why
it exists (with the instance that made it necessary), and **how it is judged** — a rule without a test that
can fail is a preference, not a convention.

| Article | The rule |
|---|---|
| [`reentrant-components.md`](reentrant-components.md) | every major component is reentrant — re-evaluable, restartable, replaceable and fault-tolerant — deriving state and progress from durable records, never from event delivery or one process lifetime |

## How a convention gets here

1. A defect or a decision makes the rule necessary — the article names it, so a reader can see the cost of
   not having had it.
2. The rule is stated so that a violation is recognisable, with the anti-pattern it replaces.
3. Something judges it: a unit test, a verifier, or both. The article links the ones that would fail if the
   system regressed.
4. The entry point above lists it, and the root [`AGENTS.md`](../../AGENTS.md) points here.

## Read next

[`./reentrant-components.md`](reentrant-components.md), and
[`../INDEX.md`](../INDEX.md) for the folder's own entry point.
