---
title: Full loop goal
version: 1.0.0
description: How to turn a large job into a goal that runs research → understand → plan → implement → verify → fix for a stated number of cycles, with each cycle's evidence required before it counts.
grounded_in:
  - owner statement 2026-10-17 that a big job should be set up as a goal that researches, understands, plans, implements, verifies, fixes and loops three times
  - the goal subsystem's reentrancy convention, which this procedure relies on for surviving restarts
---

# Full loop goal

**Use this when** a request is too large for one turn and the owner wants it done properly rather than quickly:
a UI to match, a subsystem to build, a document to re-derive. The goal tool gives the rounds; this skill says
what a round must contain.

## Write the objective as cycles, not as a wish

An objective that says "match DSH's UI" invites a round that declares victory. An objective that says what a
**cycle** is, and how many, invites evidence:

```
Run the <job> loop three times. Each cycle: (1) research what the reference does — measure it, do not read it;
(2) understand why it does that, and whether this project has the mechanism for it; (3) plan the smallest fix
that makes the difference disappear; (4) implement it; (5) verify by measurement, screenshot and a new
assertion in the checks; (6) fix what the verification found. A cycle counts only when its evidence is in the
document and the suites are green. Record each cycle in <the document> and the lessons in the skill.
```

## The round contract

| Phase | Evidence the round must produce |
|---|---|
| research | a measurement of the **reference**, with the element named; not a memory, not a snapshot read |
| understand | whether the difference is a mechanism this project lacks (a feature) or a value/arrangement (a fix); a feature is recorded, not half-built |
| plan | one sentence per change, and why the alternative was rejected |
| implement | the change, in the file that owns the fact |
| verify | the same measurement afterwards, plus a screenshot when it is visual, plus an assertion |
| fix | whatever verify found; a red that cannot be fixed gets an **owner named** in the document |

## Rules that keep the loop honest

- **Leave the goal active until the last cycle has verified.** Claiming completion is a measurement too.
- **Fix one difference per cycle where possible.** A cycle that changes five things cannot say which one worked.
- **A fix without an assertion is a fix that can come back.** Each cycle adds its check.
- **Concurrent work in the same checkout is an owner, not an excuse.** If a red belongs to another session's
  in-flight refactor, name it in the document and move on; do not edit under it.
- **Write the lessons into the skill, not only into the commit.** The commit is history; the skill is what the
  next session reads first.

## When to stop

Three cycles is a default, not a target: stop when a full measurement of the reference against this project
produces no *fix* row — only *match* and *difference kept with its reason*. If that happens in cycle two, say
so and stop; padding a third cycle is how a loop becomes theatre.
