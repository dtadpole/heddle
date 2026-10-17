---
title: DSH goal management
version: 1.0.0
description: How DSH persists a goal, drives it across rounds, exposes it to the model, and shows it, verified against the installed build.
grounded_in:
  - source: human-authored
  - source: dsh-0.2.0-rc.2
---

# DSH goal management

Read against the installed DSH 0.2.0-rc.2 (`~/.volta/.../@deepseek-ai/dsh/node_modules/@deepseek-ai/`), in
five packages that split one idea: **`dsh-goal`** (the durable state machine), **`dsh-goal-round-driver`**
(what makes a goal *do* something), **`dsh-tool-goal`** (the model-facing tool), **`dsh-command-goal`**
(`/goal`), and **`dsh-client-ui-goal`** (the bar a person sees).

## 1. The durable model is one session event

`dsh-goal`'s manifest calls itself an *"event-sourced same-session goal state and lifecycle service"*.
There is exactly one event type, `goal/change` (`lib/types/domain.d.ts`), in two shapes:

- **snapshot change** — `{kind:'goal/change', version:1, operation, goal, roundsStarted, createdAt, updatedAt}`
  where `operation ∈ create | edit | pause | resume | complete | block`. The runtime *decodes and validates
  this exact field set* (`lib/index.js:139-160`): a snapshot change "must have exactly" those fields, a
  clear tombstone "must have exactly" `cleared, clearedAt, kind, operation, version` (`:122-129`), version
  must be `1`, and `updatedAt < createdAt` is refused (`:151`).
- **clear tombstone** — `{kind, version, operation:'clear', cleared: GoalRef, clearedAt}`; history is kept,
  the current goal is gone.

So the state is **not** stored anywhere else: every mutation appends one complete snapshot, and replaying
the log is the state. That is the same shape heddle already uses for sessions.

## 2. The state itself

`lib/types/types.d.ts`:

```ts
GoalRef      = { id: 'goal-<uuid>', revision }        // CAS identity; every durable mutation +1
GoalSnapshot = GoalRef & { objective, phase, blockedReason?, maxGoalRounds }
GoalPhase    = 'active' | 'paused' | 'blocked' | 'complete'
GoalActivation = 'armed' | 'disarmed'                  // process-local, NEVER persisted
GoalView     = GoalSnapshot & { roundsStarted, createdAt, updatedAt, activation }
```

Two things worth separating deliberately:

- `phase` is **durable**; `activation` is **process-local** — "may this live process automatically continue
  an active goal". A resumed session therefore comes back with a durable active goal but **disarmed**
  until a human's continue/resume re-arms it (that sentence is also in the tool's own description,
  `dsh-tool-goal/lib/index.js:190-196`).
- `roundsStarted` is derived, not written as a counter: the fold counts **admitted** `user/message` events
  whose `source = {kind:'goal', goalId, revision, round}` with `round > 0` (`types.d.ts` projection notes).
  Round `0` is the initial message and is excluded. A round that was queued but never admitted therefore
  never counts.

Stable refusals are error codes, not prose (`domain.d.ts`): `GOAL_AGENT_NOT_LIVE`, `GOAL_NOT_FOUND`,
`GOAL_ALREADY_EXISTS`, `GOAL_STALE_REVISION`, `GOAL_INVALID_OBJECTIVE`, `GOAL_INVALID_MAX_ROUNDS`,
`GOAL_INVALID_BLOCK_REASON`, `GOAL_INVALID_EDIT`, `GOAL_INVALID_TRANSITION`.

## 3. The transition table

From the implementations (`dsh-goal/lib/index.js:622-760`) — each row is a decision, not a convenience:

| operation | allowed from | result phase | activation after |
|---|---|---|---|
| `create` | no current goal, **or** current is `complete` | `active` | **armed** |
| `edit` | any current goal (CAS); must change objective and/or maxGoalRounds | unchanged | unchanged |
| `pause` | `active` only | `paused` | disarmed |
| `resume` | `active` (only when disarmed), `paused`, `blocked`; refused when `roundsStarted >= maxGoalRounds` | `active` | **armed** |
| `complete` | `active`, `paused`, `blocked` | `complete` | disarmed |
| `block` | **`active` only** (a paused goal must be resumed or completed) | `blocked` | disarmed |
| `clear` | any current goal (CAS) | — tombstone, revision +1 | disarmed |

Rules that hold across the table: every mutation carries the caller's `GoalRef` and is a
compare-and-set (`expectCurrent` → `GOAL_STALE_REVISION`/`GOAL_NOT_FOUND`); only `edit` may change
`objective` or `maxGoalRounds` (`requireSameDefinition`); `blockedReason` is `{code: lower-kebab,
message: non-empty}` and exists exactly while blocked; `maxGoalRounds` is always present, resolved from
`Config.defaultMaxGoalRounds` when the caller omits it; `disarm(agent)` changes activation without
touching phase or revision.

## 4. The round driver: what "maintaining" a goal means

`dsh-goal-round-driver/lib/index.js`. It is **not** a timer; it is a serialized per-agent driver that
runs **at quiescence** — agent live, fiber running, not stopping, `agent.status === 'idle'`, and no
competing queued message (`:75-84`). Each pass (`:102-160`):

1. If a previous attempt is waiting on durability, **flush the session** first; a failed flush disarms.
2. Read the current goal; require `phase === 'active'` **and** `activation === 'armed'`, else return.
3. If `roundsStarted >= maxGoalRounds`, **block** the goal with
   `{code:'round-limit', message:'Goal reached its configured limit of N rounds.'}` and stop.
4. Otherwise `round = roundsStarted + 1`, render the continuation prompt, create a user message whose
   `source` is `{kind:'goal', goalId, revision, round}`, and queue it with `agent.followup`. A queue
   failure **blocks** with `{code:'queue-failed'}`.

Each queued round is an *attempt* with a lifecycle (`:240-294`): **queued → claimed → admitted**, or
**cancelled/stale** when the goal moved underneath it (revised, paused, disarmed) or the person
superseded the message. Only an admitted round advances `roundsStarted`; a cancelled attempt pauses the
goal if it was still active and armed at the old revision. So "the goal keeps running" is a loop of
*durable round admission*, and every checkpoint is the session log.

The continuation prompt is one block (`lib/prompt.js:12-15`):

```
Objective: "<the objective>"
Round: <n>/<max>

Continue working toward the objective in this same session. Treat the current workspace, tool results,
and durable session state as authoritative; inspect them instead of assuming earlier narration is still
current. Make concrete progress and verify the result. Before claiming completion, gather evidence that
the whole objective is achieved, read the current goal, and mark it complete. If work remains, leave the
goal active for the next round. Follow the configured goal-tool policy before reporting a blocker.
```

## 5. The model-facing tool

`dsh-tool-goal` exposes two tools (`lib/index.js:123`, `:279-330`):

- `create_goal {objective, max_goal_rounds?}` — description: *"Create a persisted goal that keeps this
  session working across automatic continuation rounds. Use it when the direct human request is a
  long-running objective, even if the user did not say 'goal'; not for single-turn work."*
- `update_goal {action, objective?, max_goal_rounds?, blocked_reason?}` — actions: `update`, `pause`,
  `resume`, `complete`, `blocked`, `get`.

Two policies live in the descriptions rather than in the service: a goal may be **inferred** from a
long-running request in any language; and **blocked** may be reported only after the same blocking
condition persists for `Config.blockedAfterConsecutiveRounds` consecutive goal rounds. Completing or
blocking also appends a wrap-up message (`<goal_complete>` / `<goal_blocked>`) instructing the model to
write the closing message and stop — the tool ends the autonomous run, not just the state.

## 6. The command and the UI

`dsh-command-goal` gives `/goal` the same verbs (`create`, `edit`, `pause`, `resume`, `complete`, `block`,
`clear`, `show`). `dsh-client-ui-goal` renders a **GoalBar** whose locale keys are the contract
(`lib/types/client/locales.d.ts`): `phase.active`, `phase.active.disarmed` (active but not continuing),
`phase.paused`, `phase.blocked`, plus `action.save`, `action.cancel`, `action.pause`, `action.resume`,
`action.edit`, `action.clear`, and aria labels for the objective and the command input. The UI's job is to
show *durable phase plus process-local activation* and offer the verbs — nothing is computed there.

## 7. What heddle takes from this

The shape translates directly, because heddle already has the two pieces DSH relies on: an append-only
session log and a projection fold. Heddle's version keeps:

- one `goal/change` event carrying a full snapshot or a clear tombstone, versioned, with the same exact
  field sets and the same `phase`/`activation` split (`activation` in memory only);
- the same transition table and the same refusal codes, with `GoalRef` compare-and-set;
- `roundsStarted` derived from admitted continuation user messages whose source is `kind:'goal'`, and a
  round driver that blocks with `round-limit` when the cap is reached;
- the same two model-facing tools (`create_goal`, `update_goal`) and the same continuation prompt, since
  the prompt is the thing a model actually reads;
- a goal bar showing phase, activation, objective and the verbs.

What heddle does **not** copy: DSH's Typert remote-service transport and its per-agent runtime registry —
heddle's session handle *is* the owner of a goal, so `GoalService` is keyed by `SessionHandle`.

**One deliberate divergence: activation across a restart.** DSH keeps `activation` process-local and disarms
a reopened goal, so a restarted process cannot spend rounds unsupervised. Heddle's owner decided the opposite
— pushing must survive a restart — so heddle derives the default activation from the durable phase (an
`active` goal is armed again in a new process) and the Web server sweeps runnable goals at boot
(`resumeAtStart`), because no event fires for a session that was already active before the restart. The
in-process override survives for a lifecycle owner that wants to stop pushing without pausing the goal. This
is recorded as a decision, with its cost — a restarted process can resume spending rounds without a person
asking — rather than left as an omission.

## Read next

[`dsh-context.md`](dsh-context.md) for the same treatment of context, and heddle's own
[`../../src/goal/`](../../src/goal/) for the implementation this reading produced.
