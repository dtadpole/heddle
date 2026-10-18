---
title: DSH Mechanisms
version: 1.5.0
description: How DeepSeek Harness implements each mechanism heddle mirrors, read from the installed packages and measured in its browser, with the context and background-job readings corrected and guarded by a check beside them.
grounded_in:
  - source: the installed DSH packages under ~/.volta, read on 2026-10-11, 2026-10-17 and 2026-10-18
  - source: DSH's Web UI on its local port 8080, measured in a browser on 2026-10-17
  - source: DSH's Web UI on its local port 3080 and the live session log under ~/.dsh, observed on 2026-10-18
  - source: the live store at ~/.dsh for the workspace and session shapes
---

# `dsh-mechanisms`

Instance of [`_context_`](../INDEX.md). Holds the reading behind every mechanism this harness
mirrors: how DSH streams a model call, how it assembles and compacts context, what a hook is
there, how it serves and protects its Web UI, and how it models workspaces and sessions.

## Why this is kept

The instruction was to follow how DSH does it rather than to invent a shape, and these five
reports are what that meant in practice — each is a reading of the installed packages, with the
file paths, type names and measured constants that a design decision actually turned on. They are
**gathered material**, not authored conclusions: the conclusions are in the code and in
[`_verifiers_/`](../../_verifiers_/INDEX.md), and a report here is only as good as the version of
DSH it read.

They first lived in a git-ignored scratch directory, which was wrong for the durable-work rule this
repository follows: anything worth citing does not stay somewhere a reboot discards. An instance of
`_context_` is the registered home for gathered material, so they moved here unchanged apart from
the frontmatter every authored artifact carries.

## What belongs in it

- [`dsh-streaming.md`](dsh-streaming.md) — the seven-variant chunk union, the assembler, reasoning as
  a first-class block, the WebSocket mux, and how a partial answer reaches a browser without ever
  entering the log.
- [`dsh-context.md`](dsh-context.md) — the request's message list, the token meter's constants, the four
  events of a compaction transaction and the pruner's own surface rewrite beside them, and the
  instruction files. Corrected against DSH 0.2.0-rc.2; what the first version got wrong is listed in
  its own last section.
- [`dsh-model-selector.md`](dsh-model-selector.md) — DSH's `conversation.input.model` seat measured state by
  state (trigger anatomy, two-level menu, grouped model list and search, effort pane, keyboard, placement, running
  turn, the durable `model/selection` record), the two-tier endpoint → model-type configuration the owner asked
  for in `~/.heddle/`, Heddle's before→after numbers, and the divergences kept.
- [`dsh-permission-modes.md`](dsh-permission-modes.md) — the access-mode chip, menu, full-access risk
  gate and refusal approval measured in DSH's browser, with the session-scoped mode heddle implements
  beside it, the designs discarded, and the loop document for that work.
- [`dsh-runtime-context.md`](dsh-runtime-context.md) — how a sandbox-mode change is recorded so a running loop and
  every later reader know the expectation changed: DSH's log-only `sandbox/mode` event and its sourced
  runtime-context snapshot (superseding header, named sections, appended after retained history, reused while
  unchanged), measured against heddle's replacing policy note, with the snapshot mechanism heddle now implements.
- [`dsh-sandbox-backends.md`](dsh-sandbox-backends.md) — how DSH confines shell and file effects on each
  platform (the seam, the bwrap/Landlock/Seatbelt/Windows-ACL profiles, writable roots, denial dialects,
  enforcement and fail-closed), probed on this Mac, with a phased plan for heddle's own backend.
- [`dsh-input-area.md`](dsh-input-area.md) — the composer card and its measured geometry (712×98 card,
  radius 28, #2c2c2e), the editor's 4/8/0/14 inset and 336px cap, the control row's order and sizes, the
  status pills, and the resizable conversation column the text and the input share; with the values Heddle
  implements and the ones it deliberately does not.
- [`dsh-hooks.md`](dsh-hooks.md) — the event points around a model and a tool call, their dispatch
  modes, and the rule that a listener is an effect of the fiber that registered it.
- [`dsh-webui.md`](dsh-webui.md) — the raw `node:http` server, the default port, the launch token
  exchanged for a cookie, and the Host and Origin fence that runs before any secret is compared.
- [`dsh-workspaces.md`](dsh-workspaces.md) — the workspace record, the bucket-naming rule, the
  equality that decides membership, and the session tree.
- [`dsh-agent-teams.md`](dsh-agent-teams.md) — the three layers: an agent is a session's driver, a subagent is a
  child run (one-shot or continuable, fresh or forked), and the experimental Agent Teams layer is a Lead plus
  durable teammates coordinated by a journal in the Lead's session, a target-confirmed mailbox and a shared
  task board; read from implementation, not only types, against 0.2.0-rc.2.
- [`dsh-jobs.md`](dsh-jobs.md) — the background-job runtime: the `ctx.jobs` seam (session-owned ids, five
  statuses, an offset-addressed output ring, first-wins settlement) and its process-local backend (10 jobs per
  owner, 256 KiB live / 16 KiB settled retention, a 150 ms pump, nothing durable), the three model-facing
  controls and the completion notice that wakes an idle owner, the four producer kinds, and the two background
  subagent lanes — one-shot is a job, continuable is a durable child — with the composition that chooses between
  them, observed live in the Web GUI.
- [`dsh-conversation-views.md`](dsh-conversation-views.md) — the view ring over one session, and the
  Trajectory ledger as a pure projection of the session window.
- [`dsh-trajectory-ui.md`](dsh-trajectory-ui.md) — the Trajectory tab measured in a browser: the dense
  table, the kind tags, the tool row that carries its result, the details pane, the toolbar and the
  timeline; plus the mapping heddle's Trajectory area is being brought to.

## The check that keeps the readings honest

A reading is only as good as the version of DSH it read, and one of these was read from a summary of
the code rather than the code: [`dsh-context.md`](dsh-context.md) carried thirteen wrong facts until
they were found by re-reading the shipped files symbol by symbol. So the readings now carry the check
that would have caught them, [`check-reading.mjs`](check-reading.mjs), run through the project's
runner:

```bash
node _tools_/verify-runner/run.mjs _context_/dsh-mechanisms/check-reading.mjs
```

It reads files only and spends nothing, and it keeps the project's contract: `0` when the readings still
describe the install, `1` when they do not — the message names the fact that moved, so the answer is
"re-read the code and correct the document", not "the check is flaky" — and `3` when no DSH install is
found. The install location is machine configuration, so `$HEDDLE_DSH_ROOT` overrides it and the usual
install paths are tried otherwise.

## Read next

[`../INDEX.md`](../INDEX.md) for the `_context_` type, and
[`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the parts these readings ground.
