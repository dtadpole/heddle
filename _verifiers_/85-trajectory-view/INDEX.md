---
title: Verifier — Trajectory View
version: 1.0.0
description: the same session read as a conversation and as an event ledger, switched by a view ring.
grounded_in:
  - source: DSH's dsh-client-ui-trajectory, read from the installed 0.2.0-rc.2 packages on 2026-10-11
  - source: owner statement in the dsh session, 2026-10-11, asking for the two-view right panel
---

# `85-trajectory-view`

Instance of this project's `_verifiers_`. **The claim it decides:** one session can be read two ways — as
the conversation it was, and as the ledger of what the harness actually did — and the two views cannot
disagree about it.

It sits beside [`90-web-ui-token`](../90-web-ui-token/INDEX.md) rather than inside it because it judges a
different thing: not who may read a session, but whether the session's own record is *legible*. The
mechanism is copied from DSH's `dsh-client-ui-trajectory`, which the owner asked heddle to match.

## Where it runs

**Headless browser.** The checks that need a page open a real Chrome with no window, through
[`_tools_/browser-use/`](../../_tools_/browser-use/INDEX.md); the rest drive the CLI and local HTTP
doubles. Nothing here needs a display, so it runs unattended.

## What the two views are

DSH's right panel offers a **view ring**: the Chat view is the conversation as a reader follows it, and the
Trajectory view is the same session as a **turn-aware ledger** — user, assistant, tool and reasoning records
grouped under the turn and step that produced them, each carrying its timing and, where the events hold the
numbers, its token usage. A record opens to show its full input and output.

Heddle's session log already holds what both views need. The ledger is therefore a **projection of the
recorded events**, not a second store: `model/request` carries the step and the estimate,
`assistant/chunk` carries the deltas as they arrived, `turn/completed` closes a turn, `turn/retry` marks a
retried step, and `assistant/completed` holds the settled message.

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

## Running it

```bash
sh verify.sh            # every check, with the verdict
sh verify.sh --list     # the check names, and why any was unjudged
sh verify.sh --json     # one parseable object
```

Exit `0` when the claim holds, `1` when it fails, `3` when it could not be judged — a host without a browser
is the `3` case.

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

## Read next

[`../INDEX.md`](../INDEX.md) for the verifications,
[`../../_context_/dsh-mechanisms/`](../../_context_/dsh-mechanisms/INDEX.md) for the DSH readings, and
[`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the parts these sit under.
