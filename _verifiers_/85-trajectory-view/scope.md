---
title: 85-trajectory-view — the two views and the scope
created: 2026-10-23T05:06:41Z
modified: 2026-10-23T05:06:41Z
level: L3
version: 1.0.0
description: What the conversation and ledger views of 85-trajectory-view are, and what the part deliberately does not judge.
status: unverified
grounded_in:
  - source: moved verbatim from _verifiers_/85-trajectory-view/INDEX.md@1.0.0
---

# 85-trajectory-view — the two views and the scope

## What the two views are

DSH's right panel offers a **view ring**: the Chat view is the conversation as a reader follows it, and the
Trajectory view is the same session as a **turn-aware ledger** — user, assistant, tool and reasoning records
grouped under the turn and step that produced them, each carrying its timing and, where the events hold the
numbers, its token usage. A record opens to show its full input and output.

Heddle's session log already holds what both views need. The ledger is therefore a **projection of the
recorded events**, not a second store: `model/request` carries the step and the estimate,
`assistant/chunk` carries the deltas as they arrived, `turn/completed` closes a turn, `turn/retry` marks a
retried step, and `assistant/completed` holds the settled message.

## What it deliberately does not judge

- **The virtualised window.** DSH mounts only the visible rows and loads earlier pages on demand. Heddle's
  ledgers are small enough that this is not yet a claim, and judging it would freeze an implementation detail
  rather than a behaviour. It becomes one when a session is long enough to need it.
- **The timing overview's gestures** — drag-to-focus, wheel-to-zoom, right-button-to-clear. DSH has them and
  heddle's band does not: a click per turn is the navigation, and gestures are a convenience over a band that
  has to be right first.
- **Selecting a range of records.** DSH lets an interval focus the ledger on every record active inside it.
  Heddle's band picks a turn, which is the granularity a session this size needs.
- **Attachment inspection.** Heddle records no images or files today, so there is nothing to judge.
