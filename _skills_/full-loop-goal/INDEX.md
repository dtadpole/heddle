---
title: Full loop goal
version: 1.3.0
description: How to turn a large job into a goal that runs research (measure, then brainstorm) → understand (then step back) → plan → implement → verify → fix for a stated number of cycles, with each cycle's evidence required before it counts.
grounded_in:
  - owner statement 2026-10-17 that a big job should be set up as a goal that researches, understands, plans, implements, verifies, fixes and loops three times
  - owner statement 2026-10-17 that each loop should include a brainstorm in the research phase, and should step back and broaden the scope where applicable
  - the goal reentrancy convention, which this procedure relies on for surviving restarts
  - owner statement 2026-10-17 that a goal's round cap defaults to 100 unless the owner names another number
---

# Full loop goal

**Use this when** a request is too large for one turn and the owner wants it done properly rather than quickly:
a UI to match, a subsystem to build, a document to re-derive. The goal tool gives the rounds; this skill says
what a round must contain.

**v1.1 adds two steps to every cycle** — a **brainstorm** inside research, and a **step back** after
understanding — plus the mechanisms in the second half. The rule that has not changed: a cycle counts only
when its evidence is in the document and the suites are green.

**v1.3 states the round cap.** A goal is created with `max_goal_rounds: 100` unless the owner names another
number in the request; that is the harness default and it is the number this skill asks for explicitly, because a
goal built by this procedure is the case the default was chosen for. The two budgets are different things and
both are stated up front: **three cycles** is what the work should need, **a hundred rounds** is the hard stop
that makes the driver block loudly if it does not converge. A request that says "loop five times" or "allow 200
rounds" overrides the relevant one, and the override is written into the objective so a restart inherits it.

## Before cycle 1: frame the job

- **Done is measured.** Write what "finished" would be *measured as*: the reference behaviour, the assertion
  that would prove it, the report a person would read. If it cannot be measured, the job is not a goal yet.
- **Name the instruments.** The reference at its address, the browser, the check runner, the commands whose
  output is evidence. A cycle that has to rediscover its instruments spends its budget on setup.
- **Budget the cycles explicitly** (three is a default) and say what a cycle is in your own words.
- **Name the round cap.** Create the goal with `max_goal_rounds: 100`, which is the harness default, unless the
  owner asked for a different number. Say which number was used in the document: the cap is what turns "still
  working" into a **block** that a person can see, and a goal that quietly runs out of rounds is
  indistinguishable from one that finished.
- **Take the baseline.** Measure the job's starting state now; without a before, a later "it matches" is an
  opinion.

## Write the objective as cycles, not as a wish

An objective that says "match DSH's UI" invites a round that declares victory. An objective that says what a
**cycle** is, and how many, invites evidence:

```
Run the <job> loop three times. Each cycle: (1) research — measure the reference, then brainstorm at least
three candidate approaches and record the discarded ones; (2) understand — why the reference does it, whether
this project has the mechanism, then step back and check the objective against what was learned (broaden,
narrow or re-cut the scope, and edit the goal if it changed); (3) plan the smallest fix that makes the
difference disappear; (4) implement it; (5) verify by measurement, screenshot and a new assertion that has
been shown to fail without the fix; (6) fix what the verification found. A cycle counts only when its
evidence is in the document and the suites are green. Record each cycle in <the document> and the lessons in
the skill.
```

## The cycle, phase by phase

| Phase | The round must produce |
|---|---|
| **research — measure** | a measurement of the **reference**, with the element named; not a memory, not a snapshot read |
| **research — brainstorm** | 3–5 candidate approaches grounded in that measurement, at least one boring and one radical; the discarded ones recorded with why |
| **understand** | whether the difference is a mechanism this project lacks (a feature) or a value/arrangement (a fix); a feature is recorded, not half-built |
| **step back** | the objective re-read against the evidence: still the right job? did it widen or narrow? should the fix target the *class* rather than this instance? |
| **plan** | one sentence per change, the chosen approach, and why the alternatives were rejected |
| **implement** | the change, in the file that owns the fact |
| **verify** | the same measurement afterwards, a screenshot when it is visual, a new assertion **shown to fail without the fix**, and the suites green |
| **fix** | whatever verify found; a red that cannot be fixed gets an **owner named** in the document |

### Research: measure first, then brainstorm

The order matters. A brainstorm before the measurement produces guesses; after the measurement it produces
**hypotheses about a fact**. Five prompts that have paid for themselves:

1. What would the reference's author have done here, and what does that imply about the mechanism?
2. What is the smallest change that makes the difference disappear?
3. What change makes the whole **class** of difference disappear? (This is the question that turns a cycle
   into a mechanism.)
4. What would we do with ten times the time — and is any of it cheap enough to do now?
5. What have we assumed that the reference contradicts?

Record every candidate you discard and why. The discards are what keep a later cycle from re-litigating the
same choice, and they are the raw material for the step-back.

### Step back: check the scope before spending a cycle

Once per cycle, after understanding, ask three questions and act on the answer:

- **Is the objective still the right one?** If a measurement contradicted it, say so in the document and, when
  the scope changed, edit the goal's objective through the goal tool — a scope change that lives only in
  someone's head is drift.
- **Did the evidence widen or narrow it?** Two fixes for the same class of defect mean the job is a mechanism,
  not two values: broaden. A fix that needs a missing feature means the job is bigger than the cycle: record
  the feature and do not half-build it.
- **Is the target right for this project?** A reference behaviour that contradicts this project's stated
  purpose is a **divergence**, kept with its reason — not a difference to erase.

Broadening also has a cheap mechanical form: when a defect is found in one place, look for its **siblings**
(the same pattern in the neighbouring files) before closing the cycle. One measurement, a list of siblings,
and the list goes in the document.

## The document the loop keeps

The loop runs across goal rounds and survives restarts, so the **document is its memory**, not the context
window. Keep it re-readable in one sitting, and write one compact block per cycle:

```
Cycle n — <one-line aim>
  measured:   <the reference fact and the instrument>
  brainstorm: <candidates>  chosen: <one>  discarded: <why>
  step back:  <keep / widen / narrow / re-cut>  <what changed, and the goal edit if any>
  changed:    <files, one line each>
  evidence:   <before → after, screenshot, the assertion that fails without the fix>
  reds:       <none | named, with its owner>
  coverage:   <cells visited, cells not visited and why>
  invariants: <what the structural change could have broken, and the assertion that it did not>
  lessons:    <the mechanism that now prevents a repeat>
```

A fresh session must be able to resume from that block: cycle number, the phase in progress, the open
questions, and the per-fix status. If the document cannot do that, the loop is not reentrant and a restart
will repeat work.

## Mechanisms that keep the loop honest

- **Prove the check bites.** After adding an assertion, construct the failing state (or temporarily revert the
  fix), watch it fail, then restore. An assertion nobody has seen fail is a comment.
- **Two instruments for one claim.** A measurement, a screenshot or an assertion is each one instrument; when
  they can disagree, use two. Visual claims get the screenshot *and* the assertion.
- **Re-measure from a fresh process for restart and reentrancy claims.** A claim that "it survives a restart"
  is not judged in the process that made the change.
- **Pre-mortem each cycle.** Before implementing, ask: how could this cycle pass while being wrong? Name the
  instrument that would catch that. If there is none, the cycle is not ready to be called green.
- **One difference per cycle where possible.** A cycle that changes five things cannot say which one worked.
- **Checkpoint per cycle.** Commit the change, log it, and update the document and the skill **in the same
  cycle**. The commits and the document are what a later round — or a restart — resumes from.
- **A spike is research, not the plan.** When two approaches are plausible, timebox a throwaway spike for
  each; the result is a measurement and a discard note, not a branch to merge half-finished.
- **A red that belongs to another session gets an owner named.** If a red is another session's in-flight
  refactor, name it and move on; do not edit under it.
- **Lessons become mechanisms.** A lesson is "the assertion I added", "the check that now judges it", "the
  convention it became" — not a paragraph of good intentions.
- **A cycle states its coverage.** `ui-parity-audit` has a coverage matrix; a round names the cells it visited
  and the cells it did **not**, with a reason. "No differences" is only credible beside that statement —
  otherwise it means the probe did not look. An unvisited cell that is not named is the next cycle's miss.
- **A structural change keeps the invariants.** When a round moves a node, wraps it or renames a class, the
  behaviour the old structure guaranteed is asserted too (rows still render, hover still reveals, selection
  still paints, nothing overlaps), and the probe reports page errors with the failure. A render that throws
  looks exactly like missing data — that is how a `const` used before its declaration removed every session row
  while the branch still rendered.
- **Keep the goal active until the last cycle has verified.** Claiming completion is a measurement too, and it
  goes in the document.

## When to stop, and when to ask

- **Stop on evidence, not on the calendar.** Three cycles is a default, not a target: stop when a full
  measurement of the reference against this project produces no *fix* row — only *match* and *difference kept
  with its reason*. If that happens in cycle two, say so and stop; padding a third cycle is how a loop becomes
  theatre.
- **Stop early with a report** when the objective was met earlier than planned: a short evidence block beats a
  padded cycle.
- **Ask the person** when the step back changes what "done" means, when a permanent blocking condition persists
  (the goal tool's own policy governs when to mark it blocked), or when a measurement contradicts a stated
  convention. Everything else is the loop's job to decide.
- **Do not start cycle n+1 until cycle n's evidence is committed.** The next cycle's research reads the
  document and the log; an uncommitted cycle is a cycle with no history.

## Read next

[`../../_conventions_/goal-reentrant/INDEX.md`](../../_conventions_/goal-reentrant/INDEX.md) for the reentrancy
the loop relies on, [`../ui-parity-audit/INDEX.md`](../ui-parity-audit/INDEX.md) for the measurement-heavy
sibling skill, and [`../INDEX.md`](../INDEX.md) for the skills folder.
