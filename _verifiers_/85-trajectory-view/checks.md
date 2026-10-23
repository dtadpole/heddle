---
title: 85-trajectory-view — what it must get right
created: 2026-10-23T05:06:41Z
modified: 2026-10-23T05:06:41Z
level: L3
version: 1.0.0
description: The claims 85-trajectory-view judges about the two views of one session, and how it judges them.
status: unverified
grounded_in:
  - source: moved verbatim from _verifiers_/85-trajectory-view/INDEX.md@1.0.0
---

# 85-trajectory-view — what it must get right

## What it must get right

| # | Claim | Why it is not obvious |
|---|---|---|
| 1 | the view ring switches between Chat and Trajectory | a switcher that only restyles looks identical in a screenshot |
| 2 | the ledger groups records under their turn and step | a flat list of events is the raw log, not a ledger |
| 3 | a record's timing comes from its own events, and an in-flight record shows a start **without** inventing elapsed time | a duration for something still running is a fabrication |
| 4 | token counts appear where the events carry them, and are absent rather than zero where they do not | a fabricated `0` is worse than a blank |
| 5 | a record opens to its full input and output | the point of the ledger is the detail the chat view collapses |
| 6 | the view opens at the **tail**, and following stops when a reader scrolls up | otherwise streaming yanks the reader away from what they are reading |
| 7 | both views read one session through one route | two fetches that disagree is how a projection drifts from its source |
| 8 | a **timeline** above the ledger projects the session's recorded span, one pickable segment per turn, and picking one takes the ledger to that turn | a long ledger is otherwise navigated by scrolling and hoping |
| 9 | a record with no timing contributes no timeline span, and a running record's span is marked running | a bar drawn from a guessed start is a bar that lies |
| 10 | every row carries its kind as an annotation, and a row is one line that opens on click | a kind that is only a word in a long line cannot be scanned for |

## How it is judged

A real browser, because the failure this guards against is a view that answers `200` and renders nothing —
which is exactly how the Chat view's history broke once, and no API-level check could see it. The API half
is judged too: the ledger shape must carry turn, step, kind, timing and usage as **fields**, not as prose a
check would have to parse.
