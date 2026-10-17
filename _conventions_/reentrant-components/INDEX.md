---
title: Reentrant components
version: 1.0.0
description: Every major component is reentrant — re-evaluable, restartable, replaceable and fault-tolerant — deriving its state and progress from durable records rather than from event delivery or one process lifetime.
grounded_in:
  - source: human-authored
  - source: owner statement 2026-10-17 that systems always use reentrant conditions, not point events, for major state tracking and resumption
  - source: owner statement 2026-10-17 defining this as a system design pattern where any major component can be reentrant and survive a harness restart and intermittent errors from components being removed, upgraded, added or changed
---

# Reentrant components

The first Heddle convention. It is an instance of `_conventions_` (one folder per convention); see the
[folder's entry point](../INDEX.md) for what a convention must carry.

**The rule.** Every major component must be **reentrant**: it can be re-entered, re-evaluated, restarted,
replaced or degraded at any moment, and it derives its state and its progress from **durable records** —
never from the delivery of a point event, and never only from memory that one process lifetime owns.

The inverse — a component whose next step depends on an event arriving exactly once, on a collaborator
always being present and the same version, or on state that exists only in memory — is forbidden for any
component that tracks major state or resumes work.

## What "reentrant" means here

All four hold, or the component is not reentrant:

1. **Re-evaluable.** Its next action is a pure function of durable state. "What should happen now?" can be
   asked at any time, any number of times, by any caller — and the answer is the same.
2. **Restartable.** After the harness restarts it rebuilds from durable state and continues. No progress lives
   only in memory, and since no event fires for work that was already underway, it learns its pending work
   from a **startup resync**, not from an event.
3. **Replaceable.** It can be removed, upgraded, re-added or swapped for a new instance while the system runs
   (a Cordis plugin unloads and reloads). The durable record and its contract outlive the instance; a versioned
   record is decoded **strictly**, so an upgraded component either understands the log or fails loudly rather
   than silently acting on a half-understood one.
4. **Fault-tolerant.** A transient failure — a model call that fails, a collaborator removed mid-call, a
   component being upgraded — leaves the subject **runnable**, and the next reconciliation retries it. A
   permanent failure is recorded as a **state** (blocked or complete, with a reason), never inferred from
   silence.

The frequently confused special case: this is a superset of "level-triggered, not edge-triggered". Using
conditions instead of point events is *how* a component becomes re-evaluable; it is not the whole of being
reentrant.

## The four inverses

| Anti-pattern | What it fails at |
|---|---|
| A `ctx.on(...)` handler (or webhook, or SSE handler) that **performs** the state change, with delivery as the only trigger | Re-evaluable and restartable: a dropped, duplicated, reordered, or post-restart-absent event is lost work |
| State that exists only in memory and cannot be folded from the durable record | Restartable and replaceable: a new instance starts blind |
| Work that is neither idempotent nor checkpointed — a retry repeats a side effect or loses progress | Fault-tolerant: every intermittent error becomes either a duplicate or a hole |
| Code that assumes a collaborator is present, the same version, and never changing | Replaceable: a component removed, upgraded or added mid-flight turns into a crash instead of a condition |

## The shape

```
durable record ──► pure decision(state) ──► action ──► durable record
      ▲                  │                      │
      │                  └── act / stop / block  │
      └──────── re-evaluate ─────────────────────┘
   edges: any number, any order — each only says "look again"
   boot:  a resync pass, because a restart has no edges
   error: the decision is asked again; transient failures stay runnable
```

Properties a judge can check, each with its test named in the next section:

1. **Durable state is the only truth.** The decision reads folded durable state, not a memory of what happened.
2. **The decision is pure.** `decide(state)` returns act / stop / block: no clock, no event history.
3. **Edges are redundant hints.** More than one way to learn that state may have changed; a single
   subscription whose delivery is the only trigger is the anti-pattern.
4. **A mid-action edge is not lost.** Edges collapse into a `requested` flag on a per-subject lane; a lane
   already draining keeps the flag and re-evaluates once more before settling.
5. **One action in flight per subject.** A second request joins the lane (and may add a pass) rather than
   starting a concurrent chain; a nested request from inside an action finds the lane busy.
6. **Startup is a resync.** At boot, scan durable state and feed the condition; only the long-lived owner does
   it, never a one-shot command.
7. **Actions yield.** Yield to the event loop between actions: a fast backend otherwise starves the process
   (measured: a 500-round chain left the server alive and unable to answer), and the yield is the window in
   which a person's override lands.
8. **Stopping is part of the condition.** "Nothing more to do" is a state (phase, budget, absence), not the
   absence of a subsequent event.
9. **Records are versioned and strict.** An unknown version, a field set that does not match, or a value that
   contradicts its own phase fails replay loudly; a newer component must not guess at an older log's meaning.
10. **An absent collaborator is a condition.** A missing service is read as absent (Cordis `inject` keeps the
    plugin pending; an optional read answers `undefined`), and the component degrades or waits — it does not
    crash, and it does not silently do half the work.

## The instances that made this a rule

| Defect | Which property it violated |
|---|---|
| An armed goal was **idle after the harness restarted** — the event that would have pushed it had fired in the previous process | restartable (2) and startup resync (6) |
| An edge that arrived **during a chain was swallowed** by the chain already running — a goal completed by a model mid-round went unacted on | re-evaluable and mid-action edge retention (1, 4) |
| A fast model **starved the process**: 500 rounds left it alive and unable to answer a request, because a chain of microtasks never yields | the yield property (7) |
| A completion that left `blocked` **carried the block reason into the next phase**, so the fold refused the log it had just written | durable record consistency and strict decoding (1, 9) |
| The whole Web server needed **no change** when the goal driver was added — and the goal driver being *absent* leaves goals idle without corrupting them, while adding it back resumes them through the boot resync | replaceable (3) and absent collaborator (10) |

## How it is judged

| Property | Where it would fail |
|---|---|
| re-evaluable: the decision is pure | `test/goal-driver.test.ts` — the round decision cases, no clock and no history |
| mid-action edge re-evaluated, not lost | the same file — a round completes the goal while the chain runs; the awaited chain settles on the *new* state |
| one action in flight, nested request finds the lane busy | the same file — the drain promise is stored before the drain starts |
| startup resync finds exactly the runnable subjects | the same file — the boot sweep requests the active goal and nothing else |
| actions yield, so a person can override between them | the same file — a macrotask scheduled during a round gets to run and pauses the goal |
| transient failure leaves the subject runnable | the same file — a turn that throws leaves the goal active and armed |
| restartable: pushing survives a restart | `_verifiers_/80-web-ui/check-goal.mjs` — the harness is killed mid-push, restarted on the same store, and the goal continues without a turn and without a person |
| replaceable: a new instance over the same record picks up the work | `test/goal-driver.test.ts` — a reopened `GoalService` drives the goal the previous instance started |
| versioned records decoded strictly | `test/goal.test.ts` — a snapshot whose phase and reason disagree is refused; an unknown version fails loudly |

## Recognising a violation

- A `ctx.on(...)` (or webhook, or stream handler) that **performs** the state change instead of requesting a
  reconciliation.
- State that exists only in memory and cannot be folded from the log.
- A timer that exists to paper over a missed event ("retry in five seconds").
- A single trigger with no way to recover it: no sweep, no re-read, no second edge.
- Work not serialized per subject, so two triggers interleave.
- A collaborator read without an absence check, or an assumption that it is the same version as last time.
- A version bump in a durable record's shape without a strict decoder that refuses what it does not understand.

## Where it applies

| System | Status |
|---|---|
| goal round driver | the worked example — all ten properties |
| context assembly | reentrant by construction: the surface is folded and re-derived on every request |
| session store | reentrant by construction: append-only log, fold on open, torn-tail repair, incremental cache invalidated by generation |
| workspace membership | derived from canonical paths on every read, so a moved or re-registered folder needs no migration |
| Web UI live state | **partial**: the page follows the server's stream *and* re-reads on selection, but has no boot resync — the named gap |
| the Web UI daemon | the supervisor is judged by its own part; kill-and-recover is the same shape of claim |
| any new component | the ten properties above are the review list |

## Amendment

This article is a **convention**, not a constitution: an agent may amend it with a diff, its reasoning, and
the test that would fail if the rule were violated. What it must not become is a preference that nothing
judges.
