---
title: Goal reentrancy
version: 1.0.0
description: How the goal subsystem meets the reentrancy standard — durable goal state, a pure round decision, a driver that survives restart and replacement, and the tests that would catch a regression.
grounded_in:
  - source: human-authored
  - source: owner statement 2026-10-17 that systems always use reentrant conditions, not point events, for major state tracking and resumption
  - source: owner statement 2026-10-17 that reentrancy is a system design pattern where any major component survives a harness restart and intermittent errors from components being removed, upgraded, added or changed
---

# Goal reentrancy

The first Heddle convention: the **goal subsystem**'s application of the
[reentrancy standard](../INDEX.md#the-reentrancy-standard). The standard — re-evaluable, restartable,
replaceable, fault-tolerant, and the ten checks — is stated once in the folder entry point; this article says
how goals meet it, which defects made it necessary, and what would catch a regression.

## The goal is the durable subject

A goal is not a record that is updated; it is an **event** appended to the session log. Every mutation writes
one `goal/change` carrying the complete snapshot (or a clear tombstone), and the current state is the fold of
that log, with a `GoalRef{id, revision}` compare-and-set on every change. `roundsStarted` is not a counter but
a count of **admitted** goal rounds, each of which is a user message the harness wrote with
`source = {kind:'goal', goalId, revision, round}`.

That single choice is what makes the rest of the standard reachable: a restart, a replacement driver or a
failed round all begin by folding the same durable record.

## How it meets the standard

| Property | Mechanism in `src/goal/` | Where it would fail |
|---|---|---|
| re-evaluable | `decideGoalRound(view)` is pure: no clock, no event history; any caller may ask "what now?" | `test/goal-driver.test.ts` — the round-decision cases |
| mid-action edge not lost | edges collapse into a `requested` flag on a per-session lane; a draining lane keeps the flag and re-evaluates once more | the same file — a round completes the goal while the chain runs; the awaited chain settles on the *new* state |
| one action in flight | the drain promise is stored before the drain starts, so a nested `request` finds the lane busy | the same file — a serialized second trigger |
| startup resync | `resumeAtStart` folds every session and requests the runnable goals; only the Web server calls it | the same file — the boot sweep requests the active goal and nothing else |
| restartable | activation defaults from the durable phase: an `active` goal is armed again in a new process | `_verifiers_/80-web-ui/check-goal.mjs` — killed mid-push, restarted on the same store, continued without a turn and without a person |
| replaceable | a new `GoalService`/driver over the same log takes over; no state lives only in the old instance | `test/goal-driver.test.ts` — a reopened service drives the goal the previous instance started |
| absent collaborator | the driver row is optional; with it absent goals are idle but intact, and adding it back resumes through the boot sweep | the same file and the boot-sweep test |
| actions yield | `setImmediate` between rounds | the same file — a macrotask scheduled during a round gets to run and pauses the goal |
| fault-tolerant | a turn that throws leaves the goal active and armed for the next reconciliation | the same file — a failed turn stays runnable |
| stopping is a condition | `decideGoalRound` stops on phase/activation and **blocks** at the cap rather than stopping silently | `test/goal.test.ts` — every transition and refusal |
| records versioned and strict | `goal/change` carries version 1; field sets, revision sequencing and phase/reason agreement are refused loudly | `test/goal.test.ts` — a snapshot whose phase and reason disagree is refused |

## The defects that made this a convention

| Defect | Property it violated |
|---|---|
| An armed goal was **idle after the harness restarted** — the event that would have pushed it had fired in the previous process | restartable, startup resync |
| An edge that arrived **during a chain was swallowed** by the chain already running — a goal completed by a model mid-round went unacted on | re-evaluable, mid-action edge retention |
| A fast model **starved the process**: 500 rounds left the server alive and unable to answer a request | actions yield |
| A completion that left `blocked` **carried the block reason into the next phase**, so the fold refused the log it had just written | durable state consistency, strict decoding |
| The Web server needed **no change** when the driver was added, and the driver's absence leaves goals idle without corrupting them | replaceable, absent collaborator |

## What is partial, and not hidden

- **One process per session.** Two processes around one session are out of scope: the driver is per-process
  and the store is single-writer by design. Activation is process-local for exactly that reason; the durable
  phase is what a restart reads.
- **A one-shot CLI does not sweep.** `heddle tree` and `heddle --turn` must not start model calls for sessions
  they are not working on, so only the server calls `resumeAtStart`. A goal is therefore resumed when the
  server starts, not by an unrelated command.
- **A round interrupted by a crash is still an admitted round.** The message was appended before the turn ran;
  the count reflects the log, and the next round is numbered after it. This is a decision, stated here rather
  than discovered.
- **A driver removed mid-flight** leaves the goal active and intact; nothing resumes until the driver is
  present again and a boot resync (or an edge) asks it. There is no supervisor for a component's absence —
  that is what a `monitoring-reentrant` convention would speak to.

## Recognising a regression in this subsystem

- A goal action performed **inside** an event handler rather than requested as a reconciliation.
- Goal state kept in memory (a counter, a cache of rounds) that the log cannot reproduce.
- A single trigger with no sweep — a goal that can only advance when a turn happens to complete.
- A round started while another is in flight, or two chains for one session.
- A `blocked` transition or a `complete` that leaves the block reason behind.
- A driver that never yields, so a person cannot pause and the server cannot answer.

## Amendment

This article is a **convention**, not a constitution: an agent may amend it with a diff, its reasoning, and
the test that would fail if the rule were violated. What it must not become is a preference that nothing
judges.
