---
title: DSH runtime context and the sandbox-mode change
version: 1.0.0
description: How DSH records a sandbox-mode change so a running loop and every later reader know the expectation changed, measured against heddle's replacing policy note, and the snapshot heddle now appends instead.
grounded_in:
  - source: the installed DSH packages under ~/.volta, read on 2026-10-17 (dsh-sandbox-policy 0.2.x, dsh-system-prompt, dsh-agent-loop)
  - source: measured heddle runs on 2026-10-17 (mid-turn switch and restart probes in the evidence block)
  - source: the owner's question on 2026-10-17, "when I change from one sandbox mode to another, shall we insert that context to the session, so that whether active loop, or future work will know the sandbox expectation has changed? check how DSH does it."
---

# DSH runtime context and the sandbox-mode change

The question this reading answers: when a session's sandbox mode changes, should the **session** record that the
expectation changed — for the loop that is running, and for everything that reads the session later? DSH's answer
is yes, and its mechanism is more specific than "insert a message": the change is a log-only event, and the next
assembled request appends a **full runtime-context snapshot** as a sourced user message after retained history,
because the policy is one contribution to that snapshot.

## What DSH does, from the installed packages

Paths below are under `~/.volta/tools/image/packages/@deepseek-ai/dsh/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`.

**1. The switch is one log-only event.** `dsh-sandbox-policy/lib/index.js`:

```js
function setSandboxMode(session, mode) {
  session.append("sandbox/mode", { mode })
}
```

`README.md` is explicit: "A runtime switch is one log-only `sandbox/mode` event on the session it applies to — the
switch IS its event, and nothing mutates mode state out of band. `effective = explicit grant ?? fold(events) ??
deployment default` … **the event stays log-only**; before each request, the owner contributes the current fact to
the full runtime-context snapshot, and the agent loop logs that snapshot as a sourced `user/message`." The event
never takes a surface position and is never itself sent to a model.

**2. The policy is a contribution to the dynamic runtime context, not a system section.**
`dsh-sandbox-policy/lib/index.js` registers it with the system-prompt service:

```js
scope.systemPrompt.context({
  name: "sandbox:policy",
  order: scope.systemPrompt.getContextOrder("SANDBOX_POLICY"),
  text: (context) => {
    const session = context.agent?.session
    return session === void 0 ? "" : renderPolicyContext(this.resolve({ session }))
  }
})
```

The contribution is capability-neutral ("Any available operation enforced by the DSH file sandbox …"), and
`README.md` states: "The stable system prompt remains byte-identical across mode changes."

**3. The loop logs a changed snapshot as a sourced user message.** `dsh-system-prompt/lib/index.js` renders the
snapshot:

```js
function joinContextSections(sections) {
  const body = sections.map((section) => section.text).join("\n\n")
  if (body.length === 0) return ""
  return `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n${body}`
}
```

`dsh-agent-loop/lib/index.js`'s `RuntimeContextProjection` decides whether it is new:

```js
project(current, sections) {
  if (this.retained === void 0 && current.length === 0) return;
  const snapshot = current.length === 0 ? CLEARED : current;
  if (this.retained?.text === snapshot) return;
  return createUserMessage({
    content: [{ type: "text", text: snapshot }],
    source: sections.length === 0 ? { kind: SOURCE }
      : { kind: SOURCE, form: "snapshot", sections }
  });
}
```

where `SOURCE = "runtime-context"` and `CLEARED = "Current runtime context: none. Earlier runtime-context
snapshots no longer apply."`. The loop calls it at **preStep**, before every model request:

```js
const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal));
const sections = renderContextSections(assembly);
const context = this.runtimeContext.project(joinContextSections(sections), sections);
const decision = await this.dispatch.waterfall("agent/pre-step", {
  messages: claimed, ...position, signal
}, () => Promise.resolve({
  kind: "enter",
  messages: context === void 0 ? claimed : [...claimed, context]
}));
```

So the behaviour is:

| Situation | DSH |
|---|---|
| Nothing changed since the retained snapshot | no event, no message; the request reuses the retained snapshot |
| A contribution changed (e.g. the sandbox mode) | the new snapshot is **appended** after retained history as a `user/message` with `source.kind = "runtime-context"`, `form: "snapshot"`, `sections` naming each contribution |
| The change lands mid-turn | the next `preStep` of the same turn sees it, because assembly happens before every request |
| A fresh process resumes the session | the retained snapshot is restored from the log by scanning the newest owned user message, so an unchanged request writes nothing |
| Everything cleared | a `CLEARED` snapshot is appended |
| An earlier snapshot is in history | it is never rewritten; the newer snapshot's header tells the model it supersedes it |
| The label | the message is attributable (`runtime-context` + section names), so it is not the person's words and a reader can tell which subsystem said it |

The `sections` attribution exists so a consumer can present each part ("sandbox:policy", the approval policy, the
delegation-scope statement, …) without re-splitting the joined prose; `dsh-subagent` uses the same mechanism for
its fixed delegation-scope statement, documented as "a runtime-context contribution rather than a system-prompt
section, so the deployment's system prompt stays uniform across parents and children."

**4. A mode change is not a separate chat notice.** DSH does not append "the sandbox mode changed to X." The
durable trace is the `sandbox/mode` event, and the model-visible trace is the next snapshot's changed text. The
earlier snapshots stay in model history, which is what lets a later step or a reader see *when* the expectation
changed without the system prompt being rewritten.

## What heddle did before this cycle, measured

- `permission/mode` was already DSH's log-only event (`src/session/mode.ts`, folded last-wins over the deployment
  default, inherited by delegated children at creation).
- The model-visible policy was a single `context/note` with origin `sandbox-policy`, **replaced** when the
  statement changed, written at the start of every round (`src/context/service.ts` `recordRuntimePolicy`,
  `src/agent/loop.ts`).
- It had no superseding header, no structured source/sections, and kept only the latest snapshot in model history.

Measured on this branch before the change (two HTTP turns on a local double, then a third probe for a mid-turn
switch): the mode change was seen by the active loop (request 2 of the same turn carried `read-only`; the earlier
"stale" reading was a script bug — it changed the mode after the turn had finished), but request bodies carried
**one** statement and no runtime-context header (`headers: [0, 0]`), and the session log held one replacing
`sandbox-policy` note. So the model always knew the current mode; what was missing was the **record of the change**
— the earlier expectation, its attribution, and the superseding statement DSH gives a model that reads several
snapshots.

## Candidate designs, and what was discarded

| # | Candidate | Verdict |
|---|---|---|
| 1 | Adopt DSH's runtime-context snapshots: a changed snapshot appended as a sourced user message with the superseding header and named sections; unchanged requests reuse it | **Chosen** — same mechanism, same visible sentence, same history semantics; the earlier snapshots are what make a change legible afterwards |
| 2 | Keep the replacing note, and add a separate "mode changed" notice in the transcript | **Discarded** — a second fact in a second place; DSH has no such notice, and a transcript notice is neither model history nor the policy statement |
| 3 | Append a plain user message "The sandbox mode changed to X" at the change event | **Discarded** — it would be an imperative notice rather than standing context, would go stale after a second change, and would not tell the model what the policy *means* |
| 4 | Put the policy in the system prompt and rewrite it on change | **Discarded** — DSH keeps the system prompt byte-identical for the cached prefix; dynamic facts belong in the runtime-context snapshot |
| 5 | Append snapshots but drop the header and attribution | **Discarded** — several "Current …" statements with no superseding sentence is worse than one; the header and `sections` are the parts that keep the history readable |
| 6 | Migrate by leaving the old `sandbox-policy` note in place | **Discarded** — a session created before this cycle would show two "Current heddle file policy" sentences, one stale and with no superseding header; the first snapshot replaces the legacy note instead |

## Understand and step back

The distinction that decides the design is **state recording versus context recording**:

- the `permission/mode` event records the *decision* (the switch, its order, its audit trail);
- the runtime-context snapshot records what the model *was told* at each step (the policy, in the words of the
  mechanism, attributed to the harness).

Heddle had the first and a lossy version of the second. DSH's version is lossy in neither: an append-only event for
the decision, an append-only model history for the statements, and a superseding header so a model reading old and
new snapshots knows which one applies.

Widened cases checked before narrowing:

- **Mid-turn switch:** assembly happens per round, so the same turn's next request gets the new snapshot — verified
  by a scripted slow tool (the window a person's switch lands in) rather than assumed.
- **Idle switch:** nothing is written until a request is prepared; the event is immediate, and a later request sees
  the change. That matches DSH (the snapshot is a `preStep` product, not a listener side-effect).
- **Restart/fresh process:** the retained snapshot is found by scanning the log for the newest runtime-context
  note; an unchanged request writes nothing and a later change appends one snapshot.
- **Revert:** changing back is a change, so it appends; the latest snapshot is the mode actually in force.
- **Delegated children:** a child inherits the mode at creation (already built) and its own loop writes its own
  snapshot; nothing here widens a child, so the check keeps its scope and the unit suite's inheritance test still
  guards that route.
- **History growth:** one snapshot per change, not per request; an unchanged round costs no event.
- **Human readers:** the trajectory (ledger) names the runtime-context rows and carries the full snapshot text in
  the details pane; the Chat transcript still does not draw the harness's words as a person's turn.
- **Legacy sessions:** a session written by the replacing mechanism has one stale `sandbox-policy` note; the first
  snapshot replaces it so the model reads one current policy.

Narrowed away, with reasons: no per-request snapshot rewriting (that is the replacing bug again), no system-prompt
change (DSH keeps it stable), no separate mode-change notice (DSH has none; the event is the decision record), and no
snapshot pruning (changes are rare; the existing context budget prunes if a conversation ever gets long).

## Plan, one sentence per change

1. `src/context/service.ts`: add `recordRuntimeContext(handle, sections)` — render DSH's header + joined sections,
   dedupe against the retained snapshot, append a sourced `context/note` on change, migrate a legacy
   `sandbox-policy` note by replacing it, and append the `CLEARED` snapshot when every section is empty.
2. `src/agent/loop.ts`: call it at the start of every round with the `sandbox:policy` section, where the replacing
   note used to be written.
3. `src/server/ledger.ts`: label the `runtime-context` origin "runtime context" so the Trajectory view attributes
   the statement to the harness rather than the person.
4. `test/runtime-context.test.ts`: new unit claims for append-on-change, superseding header, unchanged dedupe,
   revert, restart, legacy migration, cleared, system-prompt stability and transcript exclusion.
5. `_verifiers_/75-permission-sandbox/check-policy-context.mjs`: rewrite to judge the snapshot sequence across
   turns (one, then old+new, then no new on unchanged, then a third on revert) and the log attribution.
6. `_verifiers_/75-permission-sandbox/check-runtime-context.mjs`: new checks for the mid-turn switch reaching the
   running turn's next request and for a restarted process reusing/re-appending correctly.
7. `_verifiers_/80-web-ui/check-runtime-context.mjs`: new browser claim that the Trajectory view names both
   snapshots (with the policy text in the details pane) and the Chat view does not draw them as turns.
8. Remove the replaced note test from `test/sandbox-backend.test.ts`; update the verifier indexes and this document.

## Evidence

**Failed first.** The unit claims failed because `recordRuntimeContext` / `RUNTIME_CONTEXT_ORIGIN` did not exist;
the rewritten policy-context check failed against the replacing implementation with `0 !== 1` ("the first request
carries one runtime-context snapshot"). Then the implementation made them green, and the two new checks were added
against the whole harness.

**After** (measured on this branch, before the merge):

| Instrument | Before | After |
|---|---|---|
| `test/runtime-context.test.ts` | missing mechanism | **7 pass** |
| `npm test` | 353 pass | **359 pass / 0 fail** |
| `npm run check`, `npm run build` | green | green |
| `_verifiers_/75-permission-sandbox/` | 15 checks | **17 checks, all pass** (rewritten policy-context, new runtime-context with 2 tests) |
| `_verifiers_/80-web-ui/` | 12 files | **13 files, all pass** (new trajectory contract) |

Measured facts in the delivered harness:

- a first turn's request carries one snapshot, `Current runtime context. This snapshot supersedes earlier
  runtime-context snapshots.` + `sandbox:policy`;
- after a switch, the next request carries **two** snapshots in history order — the earlier workspace-write and
  the new read-only — and the new one is the latest word;
- an unchanged request adds no snapshot; a revert appends a third;
- a switch made while a turn waits on a slow command appears in **that turn's second request**;
- a restarted process restores the retained snapshot from the log, writes nothing when unchanged, and appends one
  snapshot after a later change;
- each snapshot is a `context/note` with `message.source = { kind: "runtime-context", form: "snapshot", sections:
  [{ name: "sandbox:policy", … }] }`, and the `permission/mode` events remain the log-only decision record;
- the Trajectory view names both rows ("runtime context") and shows each snapshot's body in the details pane,
  while the Chat view does not draw them as turns.

Screenshot: [`heddle-runtime-context-trajectory.png`](heddle-runtime-context-trajectory.png).

## Coverage and what it deliberately does not claim

Visited: between-turn and mid-turn changes, unchanged reuse, revert, restart, legacy migration, cleared snapshots,
system-prompt stability, transcript exclusion, trajectory attribution and details. Not visited: a mode change during
a **compaction** (the snapshot is ordered after retained history, and the compactor can rewrite the surface); several
concurrent turns on one session (the harness serialises a turn per session); a child session's own snapshot beyond
inheritance (the child writes its own at its first request); snapshot pruning in a very long policy-change history.

## Invariants

The `permission/mode` event stays the only write path for a mode (the session-mode verifier still judges it), the
chip's browser contract still passes, the sandbox backend and escalation checks are untouched, the unit suite still
pins that a delegated child inherits the parent's mode, and the system prompt stays byte-identical across changes
(asserted by the new unit test).

## Lessons

- **A decision and the statement of its consequence are two records.** The event says what was chosen; the snapshot
  says what the model was told. Heddle had the first and a lossy second.
- **A change only stays legible if the old statement is kept.** Replacing the note kept the request current but
  erased the trail; DSH's superseding header is what makes keeping the trail safe.
- **The attribution is part of the mechanism.** `source.kind = "runtime-context"` plus named sections is why a
  reader, a UI, or a later subsystem can tell the harness's standing context from the person's message — and why
  the Chat view can exclude it without guessing by prose.
