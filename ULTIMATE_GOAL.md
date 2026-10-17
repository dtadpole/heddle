---
title: Heddle Ultimate Goal
level: L2
version: 2.1.0
description: What completes this project — the capabilities the owner named, the configuration system they all sit on, and the daemon that keeps the UI running, each judged by its own runnable verifier under _verifiers_.
status: unverified
grounded_in:
  - source: README.md section Roadmap and section Status
  - source: owner statement in the dsh session, 2026-10-11, that the goal is the complete harness
  - source: owner statement in the dsh session, 2026-10-11, listing the ten verifiers this file carries
goal_state: pursuing
as_of: 2026-10-11
evidence: _verifiers_ baseline run recorded in _verifiers_/INDEX.md
---

# Ultimate Goal

**This project is complete when Heddle is a harness rather than a scaffold** — it connects to backend
model servers and runs an agent loop over them; streams text and reasoning to a Web UI as they arrive;
composes its context with retention, a budget and compaction; registers tools that a configuration can
choose; runs an agentic loop in which the model calls those tools; offers hooks that intercept a model
or tool call; groups sessions under workspaces; confines file effects with a permission sandbox; and
serves all of it on localhost behind a token.

The parts below are the owner's, largely in the owner's words, plus one the owner asked for by name
after them: a configuration system designed properly. Each names the DSH mechanism it is modelled on,
because the instruction was to follow how DSH does it rather than to invent a shape. The `README.md` states the same thing in the negative — *"Status: a scaffold, not a
harness. What exists is the frame the rest hangs on."*

| # | Part | Satisfied when | Decided by |
|---|---|---|---|
| 0 | configuration system | a run composes its tree from named profiles and patch layers, includes another file, resolves environment references without putting values in the tree, fails loudly naming the row and field, and can show which layer supplied every value | [`_verifiers_/05-config-system/`](_verifiers_/05-config-system/INDEX.md) |
| 1 | LLM backends | a configured endpoint answers a real request, for more than one wire shape, and the endpoint list is configuration rather than code | [`_verifiers_/10-llm-backends/`](_verifiers_/10-llm-backends/INDEX.md) |
| 2 | streaming | main content and reasoning arrive as **separate deltas** while the model is still generating, with the same deltas recorded in the session; judged with no Web UI involved | [`_verifiers_/20-streaming/`](_verifiers_/20-streaming/INDEX.md) |
| 3 | context management | a call's messages are **derived from a surface** over the append-only log, priced against the endpoint's own window, and reduced cheaply before they are reduced expensively | [`_verifiers_/30-context-management/`](_verifiers_/30-context-management/INDEX.md) |
| 4 | pluggable tools | tools are registered as services and chosen by configuration, a tool can be added from outside the project, and a bad configuration fails loudly | [`_verifiers_/40-pluggable-tools/`](_verifiers_/40-pluggable-tools/INDEX.md) |
| 5 | agentic loop | one turn completes a multi-step task that uses tools, feeds the results back, and records every step | [`_verifiers_/50-agentic-loop/`](_verifiers_/50-agentic-loop/INDEX.md) |
| 6 | hooks | a listener can observe and rewrite a model or tool call, and refuse one, at named hook points with Cordis's own event modes | [`_verifiers_/60-hooks/`](_verifiers_/60-hooks/INDEX.md) |
| 7 | workspaces and sessions | a workspace names a target folder, a session is bound to a folder under it, and those folders are navigable as a recursive tree whose nodes the conventions classify | [`_verifiers_/70-workspaces-sessions/`](_verifiers_/70-workspaces-sessions/INDEX.md) |
| 8 | permission sandbox | read-only, workspace-write and full access are three distinct behaviours, demonstrated by refusal rather than by declaration | [`_verifiers_/75-permission-sandbox/`](_verifiers_/75-permission-sandbox/INDEX.md) |
| 9 | Web UI | a localhost page on a documented default port, and the live main-content and reasoning deltas reach a client over its stream while the model is still writing | [`_verifiers_/80-web-ui/`](_verifiers_/80-web-ui/INDEX.md) |
| 10 | Web UI token | the page **and its stream** refuse a request without the token, and answer one with it | [`_verifiers_/90-web-ui-token/`](_verifiers_/90-web-ui-token/INDEX.md) |
| 11 | Web UI daemon | a launchd agent keeps the Web UI running at the documented port, survives a kill, and does not weaken the token | [`_verifiers_/95-web-daemon/`](_verifiers_/95-web-daemon/INDEX.md) |

## What the target is not

- **Not a product with users.** Distribution is where the parts are verified from — a published package
  is how the end-to-end claim is judged — but adoption is not a part, and no verifier counts it.
- **Not model quality.** Nothing here judges how well a model reasons. The backend part asks whether
  models can be reached through the framework and configured, and its tests run against a scripted
  provider and a local double before they touch anything real.
- **Not a catalogue of tools.** Four tools and one command satisfy the tools part if they are truly
  registered rather than imported and a configuration can choose between them. Coverage is not the
  claim; the extension point is.
- **Not DSH's feature set.** DSH is the model for how the pieces fit, not a specification to exceed. A
  capability Heddle has and DSH does not is welcome and is not required.

## The constraint that is part of the goal

**Every verifier runs offline and spends nothing by default.** No API key, no quota: the checks drive a
scripted endpoint or a local HTTP double that speaks the provider's real wire shape. The one exception is
named in its own check and in the owner's instruction — the backend part must also be judged against a
real configured endpoint, and that check spends a request. It is written so a missing or unreachable
endpoint reports **unjudged** rather than passing, because "the gateway was not configured" must never be
recorded as "the gateway works".

## Status

`goal_state: pursuing`, as of `2026-10-11`. This file was **derived by an agent** from the project's own
README and the owner's statement, so it carries `status: unverified` and the owner has not ratified its
wording. Correcting the statement is the owner's act; correcting the *state* is the steward's, from
evidence.

**Every part is judged, and every check passes.** Measured on 2026-10-11 by running every verifier:
**114 checks, 0 failures, 0 unjudged**. The fifteen that waited on part 7's tree — written ahead of the
mechanism because the owner asked for the checks first — now pass, and the two checks allowed to report
unjudged (part 1's real-backend probe and the daemon check) both found their subject on this machine.
The two counts that matter are kept apart: *unjudged* is a mechanism that does not exist, and *failed*
is one that does not work.

That measurement was taken while **another session was working in the same checkout**, so it is a
reading of a moving tree: part 3 grew from five checks to eight, part 10 from nine to ten, and two new
parts arrived — `_verifiers_/85-trajectory-view/` with two checks and `_verifiers_/87-resizable-panels/`
with one. The numbers are counts of checks rather than of parts.

The checks were then **reviewed from a user's seat** and extended: what would a person rely on that
nothing yet judged? Session grouping by folder, a replacement for a built-in tool, what happens after a
compaction, whether a confined mode really confines, whether a secret stays mode 600 when it is reused,
and whether a broken hook is named rather than silently ignored. Every one of those found something.

The checks were written against the harness and found real defects in it, which is the point of writing
them. The ones worth naming, because each was invisible to reading: the scripted backend replayed its
whole script on every model call, so a refused tool call was refused again forever; `server.close()`
never resolved while an event stream was open, which is what made the Web UI verifier hang; the server's
turn API ignored `--endpoint`; a named profile was silently overridden by the project's own
configuration; and a class plugin's schema sits on a function, so validation that required an object was
checking nothing at all.

**No part is blocked.** Every part depends on work in this repository rather than on something outside
it, so the next move is a session with an objective, not a decision. The only dependency the project
cannot supply for itself is the owner's judgement on a name already in use by another agent runtime, and
that affects distribution rather than any part here.

## How the state is maintained

The `goal_state` above is a **cache of the last transition, and the ledger wins**. Every transition is an
entry in the runtime ledger, written when it happens; if this field and the ledger disagree, the ledger
is right and this field is stale. The values are `pursuing`, `delegated`, `blocked` and `complete`.

The steward reads this file every tick, may move the state between `pursuing`, `delegated` and `blocked`,
and **may not declare `complete`** — completion is an assertion about the world rather than an
observation, and it is the owner's to make.

## Read next

[`_verifiers_/INDEX.md`](_verifiers_/INDEX.md) for the ten verifiers, what each judges and what the last
run found; [`README.md`](README.md) for what the project is today and its roadmap;
[`_tools_/verify-runner/INDEX.md`](_tools_/verify-runner/INDEX.md) for the exit contract every verifier keeps.
