---
title: Goal
version: 1.0.0
description: A persisted goal, its verbs, and the round driver that keeps pushing it across rounds and restarts.
grounded_in:
  - source: human-authored
  - source: dsh-0.2.0-rc.2
---

# `goal`

Goal management, modelled on DSH's five `dsh-goal*` packages — the reading with `file:line` evidence is
[`_context_/dsh-mechanisms/dsh-goal.md`](../../_context_/dsh-mechanisms/dsh-goal.md). Three files:

| File | What it is |
|---|---|
| [`service.ts`](service.ts) | The **event-sourced state machine**: one `goal/change` event carrying a complete snapshot (or a clear tombstone); `foldGoal` replays it strictly; every mutation is a compare-and-set on `GoalRef{id, revision}`; the transition table is DSH's, including `block` only from `active` and `resume` refused once the round budget is exhausted |
| [`tool.ts`](tool.ts) | The **model's verbs**: `create_goal`, `get_goal`, `update_goal`. Two policies live in the descriptions where a model reads them — a long request may be inferred to be a goal, and a paused goal is resumed by the *person*, not the model |
| [`driver.ts`](driver.ts) | The **round driver**: a level-triggered reconciler. A round is a user message the harness writes, carrying `source={kind:'goal', goalId, revision, round}`, which is what `foldGoal` counts as an admitted round; the driver re-evaluates a pure condition on every edge, yields between rounds, and blocks with `round-limit` at the cap |

## The rule it follows

The driver is a worked example of
[reentrant components](../../_conventions_/heddle-conventions/reentrant-components.md): edges are hints, the
decision is a pure function of the folded goal, a mid-chain edge is re-evaluated rather than dropped, and a
restart is handled by a boot sweep because no edge fires for a session that was already active.

## The rule that diverges from DSH

DSH keeps `activation` process-local and **disarms** a goal when a session is reopened, so a restarted
process cannot spend rounds unsupervised. Heddle deliberately does the opposite, by the owner's rule:
**goal pushing survives a harness restart**. Concretely:

- the durable **phase** is the authority: an `active` goal is armed again when a new process folds it;
- the Web server runs a **boot sweep** (`resumeAtStart`) that hands every still-runnable goal to the driver,
  because no event fires for a session that was already active when the previous process died;
- only the server sweeps — a one-shot command (`heddle tree`, `heddle --turn`) must not start model calls for
  sessions it is not working on.

The driver is an **edge-independent condition**, which is what makes the restart case work: edges are hints
(a turn completed, the goal changed), and the sweep is the startup hint. A round that does not advance the
fold's count stops the chain instead of repeating forever, and a goal that moves during its round stops the
chain with the round attributed to the revision it started under.

## Tests

- [`../../test/goal.test.ts`](../../test/goal.test.ts) — the fold, the revision CAS, every transition and
  refusal, the block reason's lifetime, the tombstone, and the restart rule for activation.
- [`../../test/goal-driver.test.ts`](../../test/goal-driver.test.ts) — the round decision, the prompt, the
  chain's safety stops, the reentrant re-evaluation, the boot sweep, and the yield to the event loop.
- [`../../_verifiers_/80-web-ui/check-goal.mjs`](../../_verifiers_/80-web-ui/check-goal.mjs) — end to end:
  the model's tool creates a goal, the bar's verbs drive it, a capped goal runs attributed rounds and blocks,
  and an active goal keeps being pushed **after the harness is killed and restarted**.

## Read next

[`../INDEX.md`](../INDEX.md) for the source tree, and
[`../../_verifiers_/INDEX.md`](../../_verifiers_/INDEX.md) for the claims that decide the harness.
