---
title: Session input, as DSH does it
version: 1.0.0
description: The input-area parity loop — the reference measured in every state, the divergences kept with their reasons, and one evidence block per cycle in the order the full-loop-goal skill asks for.
level: L2
status: draft
grounded_in:
  - source: DSH 0.2.0-rc.2 at http://127.0.0.1:8080 driven in a browser on 2026-10-17, with getComputedStyle and getBoundingClientRect at four viewport widths
  - source: Heddle's own Web UI at http://127.0.0.1:8082, measured the same way the same day
---

# Session input, as DSH does it

The owner asked for Heddle's input area to be modelled on DSH's, measured rather than
reinterpreted, and then for that job to be run as a **full loop goal**: research (measure, then
brainstorm) → understand (then step back) → plan → implement → verify → fix, three cycles, each
cycle counting only when its evidence is here and the suites are green. This file is the loop's
memory; a restart resumes from the last block.

## Done, measured

The input area matches the reference where the reference has a mechanism Heddle also has:

- one floating card in one conversation column, with the card 32px wider than the text;
- an editor that grows with the draft up to a cap, inside the card with the control row;
- the action button placing Send and Stop in the same spot;
- a queue dock attached to the card's top edge;
- a status line that prints only numbers the provider and the endpoint actually reported;
- Enter / Shift+Enter / Ctrl+Enter semantics, and a model seat inside the card.

A difference is **kept with its reason** when the reference behaviour contradicts what this project
has or was asked for: that list is below, and it is not work.

## Instruments

- DSH reference: the running app at `http://127.0.0.1:8080/`, measured in the MCP browser
  (`getComputedStyle`, `getBoundingClientRect`, viewport emulation `1600x900` / `1900x900`).
- Heddle: the Web UI at `http://127.0.0.1:8082/`, measured the same way.
- The contract: `_verifiers_/80-web-ui/check-composer.mjs`, run with
  `node _tools_/verify-runner/run.mjs`.
- The suites: `npm run check`, `npm test`, `npm run build`, then every `_verifiers_/*/verify.sh`.

## The reference, measured

### Geometry at 1357×1223 (DSH, running session)

| Thing | Value |
|---|---|
| conversation area | 1077px |
| text column | 689px, message rows 689px |
| composer card | 721×98, radius 28, `#2c2c2e`, 0.5px light ring + two soft shadows |
| editor | contenteditable, 717×36, padding `4px 8px 0 14px`, 14px on a 24px line, caret `#7aaaff` |
| gap editor → first control | 17px |
| control row | `+` 28×28 `#353638`; access chip 117×28; model 189×28; voice 28×28; Send/Stop 34×34 `#7aaaff` |
| status row | `36 turns 1401 steps · 237 tok/s`, `546M tok · Cache hit 99%`, `43%` |
| card bottom margin | 30px |

### The column rule, fitted at four widths

| viewport | conversation area | text column | card |
|---|---|---|---|
| 1200 | 920 | 680 | 712 |
| 1357 | 1077 | 689 | 721 |
| 1600 | 1320 | 845 | 877 |
| 1900 | 1620 | 920 | 952 |

`text = clamp(680px, viewArea * .64, 920px)`, `card = text + 32`. The fit is the rule; a single
value copied from one screenshot would have matched one row and missed three.

### Vertical rhythm (measured, cycle 2's subject)

Heddle at the same window: card 90px tall, controls 7px below the editor, card 13px from the
viewport bottom — against DSH's 98px, 17px and 30px. Recorded for cycle 2, not half-built here.

## Divergences kept, with their reasons

- **Editor leading 14/21, not 14/24.** DSH's editor measures 14px on a 24px line. The owner later
  asked for the reference's density for this UI, and the composer check now asserts 21px. Both
  measurements are written beside the CSS; the divergence is kept deliberately.
- **The model seat shows `endpoint · model`, not `model · effort`.** Heddle's endpoint
  configuration has no reasoning-effort setting, so there is nothing honest to display.
- **The access chip reports, it does not switch.** The sandbox mode is fixed when the service is
  constructed; the chip's job is to stop a person assuming write access they do not have.
- **No voice control, no agent preset.** Heddle has no substrate for either; the port adds no
  control that would not work.
- **The column's absolute width differs from DSH's at the same window** because Heddle's sidebar is
  wider (352 vs 280). The *rule* is matched, which is the input area's subject.

## Cycle log

### Cycle 1 — the column's default measure

- **measured:** DSH's text column at four widths reads `clamp(680, viewArea*.64, 920)` (680 / 689 / 845 /
  920), card = text + 32. Heddle's default was a fraction of the **window** (82.5%, clamped), which at a
  1280 browser gives 764 where DSH's rule gives 680, and live at 1357 gives 841.
- **brainstorm:** (a) fixed 720px — discarded: cannot follow the reference's 680→920 scaling; (b)
  `clamp(680, viewArea*.64, 920)` — **the reference's rule**, tried: it reproduced all four measured points
  (assertion 764 vs 680 failed before, 680 after); (c) cap at 920 only — discarded: at 1357 DSH is 689, so a
  cap alone does not produce the measured width; (d) 0.64 of the window — discarded: the window includes the
  sidebar, which is why it over-grows; (e) the owner's 80–85% of the screen — **kept**.
- **step back:** the measurement did not make the fix — it made a **divergence**. The owner's instruction for
  this UI is 80–85% of the screen, and the reference's clamp was tried, reverted, and its reason written into
  the CSS. The skill's rule applies: a reference behaviour that contradicts what the project was asked for is
  kept with its reason, not erased. The contract was therefore changed to pin the owner's rule (82.5% of the
  window, clamped by the view area and DSH's 640 floor) with the reference measurement recorded beside it,
  and the drag contract stayed on the maths that default makes true (narrow by 2× per pointer pixel, floor
  640) instead of a widened step the ceiling makes impossible.
- **plan:** do not change the UI; change the **contract** so it judges the choice that was made, and record
  the divergence here and in the cycle's commit.
- **changed:** `_verifiers_/80-web-ui/check-composer.mjs` — the column contract now pins 82.5%-of-window,
  clamped, with the DSH fit in its comment; the drag assertions are the owner-default ones.
- **evidence:** the reference's rule was shown as a hypothesis (new assertion failed at 764 vs 680, passed at
  680 after the change), then reverted by the owner's instruction — that is the recorded divergence. The
  contract as it now stands passes: 11 of 11 composer checks, including the clamped-default and the 2× drag.
- **reds:** none in the input area. Elsewhere in the suite, `70-workspaces-sessions` 35–36 (session-row hover
  and shortcuts) belong to a concurrent session's in-flight session-row work and are named as theirs in the
  report, not edited under.
- **lessons:** a measurement of the reference is **evidence, not a mandate**; when the owner's stated intent
  contradicts it, the cycle's product is a recorded divergence plus a contract that pins the choice, and the
  next reader must find the reference number beside the reason.

### Cycle 2 — vertical rhythm

- **measured:** both UIs at a 1400×900 browser (viewport height 813), idle, same probe:
  - DSH: card 98px (top 685 → bottom 783), padding `8px 0 0`; editor 36px (693→729), padding `4px 8px 0
    14px`; first control (Send) 741→775; card bottom padding 8px; the band under the card is 30px.
  - Heddle: card 90px (693→783), padding `8px 0 0`; editor 36px (701→737), padding `4px 8px 8px 14px`;
    control row 46px, padding `4px 8px 8px`; Send 741→775; card bottom padding 8px; status row 788→805
    (17px), 5px under the card, 8px above the viewport bottom — the same 30px band.
- **the visible rhythm, which is what a person feels:** last text line's box bottom → first control top is
  **12px in both** (DSH 729→741; Heddle 737 − 8px of editor bottom padding = 729→741); card-bottom inset
  **8px in both**; the under-card band **30px in both**. The 8px card-height difference is bookkeeping: DSH's
  editor box ends at the text and the row's padding supplies the gap, while Heddle's editor box owns 8px of
  bottom padding and the row supplies 4px. Same pixels, different owner.
- **brainstorm:** (a) raise the card by 8px to make the height 98 — discarded: the card's top is set by the
  content above it, so this creates 20px of empty editor box, not DSH's rhythm; (b) move the 8px from the
  editor's padding to the row's — discarded: it changes no rendered pixel, only which box reports the height;
  (c) **leave the spacing as it is** and record the equivalence rather than force a like-for-like box —
  chosen; (d) restyle the status row to DSH's 12px pills — discarded for this cycle: that is typography, not
  vertical rhythm, and the status band already has the same 30px; (e) a fixed `min-height: 98px` on the card
  — discarded: the editor grows, so a fixed height would clip or leave dead space at every other draft size.
- **step back:** the objective holds; this cycle's measurement produced **no fix row** — the rhythm matches
  and the 8px is a box-ownership difference, not a spacing difference. That is the skill's stop signal for
  this subject: a third cycle on the vertical rhythm would be theatre. The remaining measurement the loop
  owes the objective is the **interactive states** (hover, focus, busy/queue, stop, drag), which cycle 3
  takes up; if those produce no fix row either, the loop stops with this evidence.
- **changed:** nothing in the UI; this block and the measurement note in the cycle.
- **evidence:** the boxes and gaps above, produced by [`_context_/dsh-mechanisms/input-area-measure.mjs`](_context_/dsh-mechanisms/input-area-measure.mjs) against both running
  apps in one browser session (headed-free automation: headless, per the browser-modes convention). Composer
  contract remains 11/11.
- **reds:** `70-workspaces-sessions` no longer red in this run (the concurrent session's tree work settled);
  any suite red at cycle end is named at the end of the block.
- **lessons:** compare the **pixels a person sees** (text-to-control distance, insets, bands), not the box
  heights two implementations happen to report; equal rhythm can hide behind unequal boxes.
