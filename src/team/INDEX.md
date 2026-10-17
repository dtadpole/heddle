---
title: Team
version: 0.1.0
description: The Agent Teams layer — durable teammates, a journal in the Lead's session, a target-confirmed mailbox and a shared task board.
grounded_in:
  - source: human-authored
  - source: dsh-0.2.0-rc.2
---

# `team`

Heddle's Agent Teams layer, modelled on DSH's experimental `dsh-experimental-agent-team` and read in
[`_context_/dsh-mechanisms/dsh-agent-teams.md`](../../_context_/dsh-mechanisms/dsh-agent-teams.md). The goal
that decides it is the session goal "Implement real Agent Teams in heddle"; this file records the design
decisions so the implementation does not have to rediscover them.

**A team is the Lead's session.** The Lead is the agent running that session; every teammate is a **session of
its own**, attributed by `parentSession` / `origin:'subagent'` / `delegationDepth` (the metadata the one-shot
delegation slice already writes). The team's shared state — membership, tasks, queued and delivered messages —
is an event in the **Lead's append-only log**, folded on demand. Nothing about the team lives only in memory,
which is what makes it restartable under the [goal-reentrancy convention](../../_conventions_/goal-reentrant/INDEX.md).

| File | What it is |
|---|---|
| [`state.ts`](state.ts) | the **pure layer**: team events, strict fold, member lifecycle, task board with revision compare-and-set, readiness and advisory write scopes, mailbox ledger. No service, no model, no filesystem — the log is the only input |
| [`service.ts`](service.ts) | the **service layer** over injected dependencies: `spawn` (provisioning event → own attributed session → first turn → active), `send` (durable queue, target-confirmed delivery, per-target serialization, provisioning queue), task create/update with journaling, `waitForChange` (journal wake + timeout + `noProgress`), Lead-only `interrupt`, and `recover` (settle provisioning from the durable child, redeliver undelivered mail) |

Live status and interruption come from [`../agent/turns.ts`](../agent/turns.ts): the process-local registry the
loop registers each turn in, provided by the `turns` profile row (optional — a minimal profile runs turns
without interruption). Planned next: `tools.ts` (the nine model-facing tools and the collaboration policy), the
team plugin that wires this service to `runTurn` and `ctx.turns`, and the Web UI view.

## Decisions, and why

1. **Teammates get their own sessions** (as DSH does), not a slice of the Lead's transcript. Attribution becomes
   the session's metadata rather than event-level `agentId`, the Lead's log stays small, and the existing
   `runTurn` drives a teammate as an ordinary turn. A same-session child remains a separate question that would
   need per-event agent identity first.
2. **Team state is event-sourced in the Lead's log.** Four event types, versioned: `team/member`, `team/task`,
   `team/message/queued`, `team/message/delivered`. The fold is strict: a phase/error disagreement, a skipped
   task revision, a duplicate delivery, a foreign `teamId` or an unknown version fails loudly.
3. **Delivery is confirmed at the target.** A queued message is delivered as a turn (or a steer, when the target
   is mid-turn) into the teammate's session with a `team-message` source, and only after reading the target's
   **own log** and confirming the message id is `team/message/delivered` appended. Transport success is not
   delivery; the target's log is.
4. **One action in flight per subject.** Journal writes and delivery are serialized per Lead and per target
   (DSH's `transact` and `dispatchTails`); a redelivery of a recorded message is a no-op.
5. **Restart is a resync.** On startup a provisioning member is reconciled from its durable child session and an
   undelivered message is retried against the persisted target; a member that cannot be resumed is `failed`
   with an error, never silently absent.
6. **Waiting is level-triggered.** A wait observes journal commits and member status changes, has a timeout, and
   answers `noProgress` when no member is running or provisioning — it never wakes anyone.
7. **Interrupt is Lead-only and keeps the inbox.** Interrupting stops the target's current turn through the
   live-turn registry; queued messages stay queued.
8. **The task board is compare-and-set**, with `claim`, `release`, `edit`, `set_dependencies`, `complete`,
   `reopen`, `reassign` (Lead-only), `delete`; readiness never starts an owner; `blockedBy` is a DAG (cycles
   refused); `writeScopes` are **advisory** warnings, not a lock.

## Acceptance (what the goal must prove)

- unit tests for the fold, member lifecycle, task CAS, readiness/cycles, delivery ledger and limits —
  [`../../test/team-state.test.ts`](../../test/team-state.test.ts) now covers this file;
- a scripted end-to-end check driving Lead → spawn → message → task → wait → result across sessions;
- restart recovery of a live team;
- clean-checkout verification (build, unit suite, the new verifier, goal checks as regression).

## Read next

[`state.ts`](state.ts), the DSH reading above, and
[`_conventions_/goal-reentrant/INDEX.md`](../../_conventions_/goal-reentrant/INDEX.md) for the standard the
layer is held to.
