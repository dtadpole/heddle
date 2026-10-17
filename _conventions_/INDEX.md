---
title: Conventions
version: 1.2.0
description: Heddle's own conventions — one instance per subject, a shared reentrancy standard, and per-component applications of it.
grounded_in:
  - source: human-authored
---

# `_conventions_`

Instance of this project's `_conventions_` type: **convention articles — agent-maintainable**. The rules are
kept here so they can be cited, diffed and judged; a rule that lives only in one session's memory is a rule
that gets forgotten.

The conventions borrowed from the wider `reflection` repository — entry points, frontmatter, commit messages,
change tracking, DSH-and-DRY, durable work, browser modes — are stated there and linked from
[`../AGENTS.md`](../AGENTS.md); they are not copied here, because one fact in one place is itself one of them.

## Shape: one instance per subject

Each child folder is **one convention instance**, named for its subject, and its `INDEX.md` *is* the article.
A convention that needs several articles, a test harness or evidence puts them beside its `INDEX.md`. A new
convention is a new folder and a new row here — not a new file in someone else's folder.

A convention here is **agent-maintainable**: an agent may propose and land one, with its reasoning and its
judge. (The mirror-image type, `_constitutions_`, is human-only to amend — nothing here carries that weight.)

Every convention carries: the rule stated so a violation is recognisable; the instance that made it
necessary; the inverse anti-pattern; the unit test or verifier that would fail on regression; and where it
applies, **including where it is only partial today**.

## The reentrancy standard

Shared by every `<subject>-reentrant` convention, so each instance states *how* it meets the standard rather
than restating it. Reentrancy is a **system design pattern**: any major component can be re-entered,
re-evaluated, restarted, replaced or degraded at any moment, and it derives its state and progress from
**durable records** — never from the delivery of a point event, and never only from memory that one process
lifetime owns.

A component is reentrant when all four hold:

| Property | Meaning |
|---|---|
| **Re-evaluable** | its next action is a pure function of durable state; "what should happen now?" can be asked at any time, by any caller, and the answer is the same |
| **Restartable** | after the harness restarts it rebuilds from durable state and continues; no progress lives only in memory; since no edge fires for work already underway, it learns its pending work from a **startup resync** |
| **Replaceable** | it can be removed, upgraded, re-added or swapped for a new instance while the system runs (Cordis plugin unload/reload); the durable record and its contract outlive the instance; versioned records are decoded **strictly**, so an upgrade either understands the log or fails loudly |
| **Fault-tolerant** | a transient failure leaves the subject **runnable** and the next reconciliation retries it; a permanent failure is recorded as a **state** with a reason, never inferred from silence |

The ten checks an instance is judged against, and the inverses to recognise:

1. durable state is the only truth; 2. the decision is pure; 3. edges are redundant hints, not decisions;
4. a mid-action edge is not lost; 5. one action in flight per subject; 6. startup is a resync; 7. actions
yield to the event loop; 8. stopping is part of the condition; 9. records are versioned and strict; 10. an
absent collaborator is a condition, not a crash.

The inverses: a `ctx.on(...)` handler that *performs* the state change; state that cannot be folded from the
record; a timer that papers over a missed event; a single unrecoverable trigger; work not serialized per
subject; a collaborator assumed present and unchanged; a record shape bumped without a strict decoder.

## The conventions

| Instance | Subject | Status |
|---|---|---|
| [`goal-reentrant/`](goal-reentrant/INDEX.md) | the goal subsystem — a persisted goal, its verbs and its round driver | **written** — the worked example, with five defects named |
| `ui-reentrant/` | the Web UI: is the page's state re-derived at boot and on a dropped stream, or does it only follow events? | planned — the named gap: the page follows the stream and re-reads on selection, but has no boot resync |
| `agent-team-reentrant/` | a team of agents: can a member be removed, replaced or added while a team goal runs? | planned — no team subsystem exists yet; the convention is written when the first one does |
| `context-management-reentrant/` | context assembly: does a re-created context service reproduce the same request from the log? | planned — reentrant by construction today (the surface is folded and re-derived per request); needs a reload check rather than a rewrite |
| `stats-management-reentrant/` | usage and token accounting: are counts derived from records, and do they survive a component swap and an anchor invalidation? | planned — the projection exists; the usage anchor's invalidation rules are the open question |
| `monitoring-reentrant/` | the daemon and supervision: does a killed supervisor come back without a person, and without double-starting? | planned — the daemon's part judges kill-and-recover; the convention would state the standard it is held to |

Only the written one exists as a folder. The rest are recorded as questions a convention must answer when its
subject arrives — a placeholder folder that says "planned" would be a rule nothing judges.

## Read next

[`./goal-reentrant/`](goal-reentrant/INDEX.md) for the first convention, and
[`../AGENTS.md`](../AGENTS.md) for the repository's entry point.
