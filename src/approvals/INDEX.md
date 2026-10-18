---
title: Approvals
version: 1.1.0
description: The approval policy, which decides whether an action may be taken at all, and the channel a person answers a question through.
grounded_in:
  - source: human-authored
  - source: the DSH user-approval package read on 2026-10-17, recorded in _context_/dsh-mechanisms/dsh-sandbox-backends.md
---

# `approvals`

The approval policy, which decides whether an action may be taken at all — and, since the sandbox-backend cycle,
the channel a question is asked through.

The two jobs stay one service because they are one decision: the **standing policy** (`allow`/`deny`/`ask`, with
named tools and an `unanswered` answer for a run nobody can answer) and the **question** a tool asks before a wider
action (`request()` emits, a person answers, and the answer is `allowed-once`, `rejected`, `cancelled`, or
`unavailable` when nothing could answer). A headless run has no answerer attached, so an `ask` is a denial with a
sentence rather than a hang; the Web UI attaches on start, pushes the card over the event stream, and answers it
through `POST /api/approvals/<id>`.

## Read next

[`../../_context_/dsh-mechanisms/dsh-sandbox-backends.md`](../../_context_/dsh-mechanisms/dsh-sandbox-backends.md)
for the reference and the loop that built the escalation ladder, [`../../README.md`](../../README.md) for the layout,
and [`../../_verifiers_/INDEX.md`](../../_verifiers_/INDEX.md) for the claims that decide whether what lives here
works.
