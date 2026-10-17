---
title: Reentrant conditions
version: 1.0.0
description: Major state tracking and resumption are level-triggered conditions re-evaluated against durable state, never a point event that must be delivered exactly once.
grounded_in:
  - source: human-authored
  - source: owner statement 2026-10-17 that systems always use reentrant conditions, not point events, for major state tracking and resumption
---

# Reentrant conditions

**The rule.** Major state tracking and resumption are **level-triggered**: a pure condition is evaluated
against durable state, and an event only says *the state may have changed* — it never carries the meaning
that a particular action must happen. The condition can be re-evaluated at any time, by any edge, any number
of times, and it decides.

The inverse — a point event that must be delivered exactly once and whose arrival *is* the decision — is
forbidden for this purpose.

## Why: what the inverse actually costs

Three failures that a level-triggered design cannot have and an edge-triggered one always can:

| Failure | What an edge-triggered system does |
|---|---|
| **A restart has no edges** | An already-active subject is never resumed: the only event that would act fired in the previous process. Heddle hit this: an armed goal was idle after the harness restarted until a person happened to send a message. |
| **An edge is dropped, duplicated or reordered** | The action is either lost forever or applied twice; the system's health depends on transport guarantees it does not own. |
| **An edge arrives mid-action** | A chain that is already running joins the old result and the new edge is swallowed — the state moved, and nothing re-read it. Heddle hit this too: a goal completed by a model during its own round left an edge that the running chain never re-evaluated. |

A condition also fails differently: it fails **visibly and at the decision**, because the decision is a
function of state that a test can construct. That is what makes it judgeable without an integration.

## The shape

```
durable state (the log) ──► pure decision(state) ──► action ──► durable state
        ▲                        │                    │
        │                        └── "stop" / "act"   │
        └──────── re-evaluate ────────────────────────┘
   edges: any number, any order — each only sets "look again"
```

Required properties, each of which a judge can check:

1. **Durable state is the only truth.** The decision reads folded durable state, not a memory of what happened.
2. **The decision is a pure function.** `decide(state)` returns act / stop / block; no clock, no event history.
3. **Edges are hints, and there is more than one.** A single subscription whose delivery is the only trigger is
   the anti-pattern; the set is deliberately redundant (`turn/completed`, `goal/change`, and a boot sweep).
4. **A mid-chain edge is not lost.** Edges collapse into a `requested` flag on a per-subject lane; a lane that
   is already draining keeps the flag and re-evaluates once more before settling.
5. **At most one action in flight per subject.** A second request joins the lane (and may add a pass), rather
   than starting a concurrent chain; a nested request from inside an action finds the lane busy.
6. **Startup is a resync.** At boot, scan durable state and feed the condition (`resumeAtStart`) — because a
   restart has no edges at all. Only the long-lived owner does this (the Web server), never a one-shot command.
7. **Actions yield.** Yield to the event loop between actions (`setImmediate`): a fast backend otherwise
   starves the process — measured: a 500-round chain left the server alive and unable to answer a request —
   and yielding is also the window in which a person's override lands.
8. **Stopping is part of the condition.** "Nothing more to do" is a state (phase, budget, absence), not the
   absence of a subsequent event.

## The instance that made this a rule

The goal round driver (`src/goal/driver.ts`) is the worked example, and the tests that follow it are the
template for judging any future instance:

| Property | Where it is judged |
|---|---|
| mid-chain edge re-evaluated, not lost | `test/goal-driver.test.ts` — a round completes the goal while the chain runs; the awaited chain settles on the *new* state |
| nested request finds the lane busy | the same file — the drain promise is stored before the drain starts |
| startup resync finds exactly the runnable subjects | the same file — the boot sweep requests the active goal and nothing else |
| actions yield, so a person can override between them | the same file — a macrotask scheduled during a round gets to run and pauses the goal |
| pushing survives a restart | `_verifiers_/80-web-ui/check-goal.mjs` — the harness is killed mid-push, restarted on the same store, and the goal continues without a turn and without a person |

## Recognising a violation

- A `ctx.on(...)` (or `EventSource`, or webhook) handler that **performs** the state change instead of
  requesting a reconciliation.
- State that exists only in memory and cannot be folded from the log.
- A timer that exists to paper over a missed event ("retry in five seconds").
- A single trigger with no way to recover it: no sweep, no re-read, no second edge.
- Work not serialized per subject, so two triggers can interleave.

## Where it applies

| System | Status |
|---|---|
| goal round driver | done — this article's worked example |
| Web UI live state | partial: the page follows the server's stream *and* re-reads on selection; a boot/resync re-read is the natural completion |
| the Web UI daemon | the supervisor is judged by its own part; a check that kills it and expects recovery is the same shape of claim |
| session and workspace trees | derived from durable records and re-read on each call, which is the level-triggered property already |

## Amendment

This article is a **convention**, not a constitution: an agent may amend it with a diff, its reasoning, and
the test that would fail if the rule were violated. What it must not become is a preference that nothing
judges.
