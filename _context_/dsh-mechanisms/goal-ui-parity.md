---
title: Goal indicator UI parity
version: 1.0.0
description: The measured difference ledger between DSH's live goal dock and Heddle's goal indicator, with the fix rows, the kept differences and their reasons.
grounded_in:
  - the live DSH UI at http://127.0.0.1:8080, read on 2026-10-17 in this very session (which runs a goal)
  - the live Heddle UI from a scripted fixture with an active goal, measured on 2026-10-17
---

# Goal indicator UI parity

Both sides were read **as rendered**, not from memory: DSH's own session at `127.0.0.1:8080` (the session with
the goal dock visible), and a Heddle fixture server holding an active goal. Screenshots:
[`dsh-goal-ui.png`](dsh-goal-ui.png) and [`heddle-goal-ui.png`](heddle-goal-ui.png).

## The ledger (before the fix)

| # | Dimension | DSH, measured | Heddle, measured | Verdict |
|---|---|---|---|---|
| 1 | state phrase | `Ongoing Goal` — 13px/24px, weight 500, primary text colour, normal case | `ACTIVE` — 11px/16.5px, weight 600, uppercase, green `rgb(47,163,107)` | fix |
| 2 | dock box | radius 12px, no border, padding `4px 5px 4px 12px`, gap 10px, height 36, hugs its content and is centred in the composer width | radius 8px, `1px solid rgb(53,53,53)`, padding `4.8px 9.6px`, gap 8px, height 37, fills the composer width | fix |
| 3 | verbs | three **icon** buttons: 28×28, radius 999px, transparent, glyph 14px, colour `rgb(173,178,184)`, 10px apart; names `Pause goal`, `Edit goal`, `Clear goal` | three-to-five **text** buttons with **native browser chrome** (`background rgb(107,107,107)`, `2px outset`, radius 0), names fail to say what they act on visually | fix |
| 4 | objective | 13px/20px, `overflow hidden`, `text-overflow ellipsis`, `white-space nowrap` | 13px/19.5px, ellipsis | match |
| 5 | glyph | a 14px goal glyph before the phrase | a 14px target glyph before the phrase | match in place; size confirmed |
| 6 | round count | **not visible** — it lives in the dock's info popover | visible text `round n/max` | fix: visually hidden, exposed as the dock's title and accessible text (Heddle has no info popover; recorded difference) |
| 7 | verbs offered while active | pause, edit, clear | pause, complete, edit, clear | kept with reason: Heddle's dock is the only place for the person's complete verb, so it stays; the anatomy (icon button, size, radius) matches |
| 8 | placement | above the composer, inside the chat column, centred | above the composer, inside the chat column | match |
| 9 | hover | icon buttons take a hover surface (same as DSH's other icon buttons) | none (native buttons do not respond) | fix |
| 10 | focus | platform focus ring | platform focus ring | match |

## The after measurements

Recorded after the fix in this same round; they are what the part 9 test asserts (a test that fails against
the old code):

| # | Assertion |
|---|---|
| 1 | the label reads `Ongoing Goal` and is 13px/weight 500 in the primary colour |
| 2 | the dock has no border, radius 12px, gap 10px and sits above the composer |
| 3 | every verb is a 28×28 `border-radius: 999px` icon button with `border-style: none`, an inline SVG glyph, and an accessible name (`Pause goal`, `Resume goal`, `Complete goal`, `Edit goal`, `Clear goal`) |
| 4 | the objective truncates with an ellipsis rather than wrapping |
| 5 | the round count is not rendered as visible text, but remains readable by assistive technology and as the dock's title |
| 6 | the dock still follows a pause live and disappears on a clear (the behaviour the previous round judged) |

## Kept differences

1. **Round count.** DSH hides it in a popover Heddle does not have; Heddle keeps it as accessible text and a
   title tooltip instead of a visible inline number, so the information is not lost and the visible row matches.
2. **Complete verb.** DSH's dock does not offer complete (it is done through the conversation); Heddle's dock
   is the person's only verb surface for a goal, so it keeps complete and edits the anatomy alone.

## Cycle 2, re-measured

| # | Row | DSH (re-measured) | Heddle after cycle 1 | Verdict |
|---|---|---|---|---|
| 2 | row surface | `background transparent`, `box-shadow: rgba(255,255,255,.06) 0 0 0 .5px, rgba(0,0,0,.03) 0 3px 8px, rgba(0,0,0,.02) 0 0 16px` | a 5% tinted fill | **fixed** — the measured hairline ring and soft shadow replaced the fill; no fill behind it |
| 5 | glyph | its own `span.nLMEza_goalGlyph > svg 14×14`, `viewBox 0 0 16 16`, `stroke-width 1`, target path | heddle's own 24-viewBox target at stroke 1.8 | **fixed** — DSH's own glyph markup adopted, so the mark is the reference's |
| 3 | icon weight | buttons draw 14px glyphs at `stroke-width 1` on a 16 viewBox | 1.8 on a 24 viewBox, visibly heavier | **fixed** — stroke 1.4 on the 24 viewBox, the same optical weight |

Everything else is either **match** (phrase, phrase typography, objective ellipsis, button box 28×28 radius 999, gap 10, dock radius 12, no border, placement above the composer) or **kept with a reason** (the round count as accessible text and title instead of DSH's info popover; the complete verb, which Heddle's dock must offer because it is the person's only goal surface). **No fix rows remain**, which is the evidence-based stop the skill asks for.

Every verb is an **icon button** — pause/resume, complete, edit and clear are 28px round buttons with an inline 14px SVG and an accessible name (`Pause goal`, `Resume goal`, `Complete goal`, `Edit goal`, `Clear goal`); the person never reads a text verb in the dock.

## Completed state

Measured on DSH's own session (which had just completed its goal): the dock is **gone** — no phrase, no goal
buttons, nothing above the composer. Heddle matched it by hiding the indicator when the durable phase is
`complete`; the record survives, and since a new goal replaces a complete one, nothing is lost by not offering
a clear action. `Active` (armed or disarmed), `Paused` and `Blocked` keep their dock, because each of those is a
current intent or needs the person. The part 9 tests judge this as a live edge: pressing complete must hide the
dock without a reload.

## Width: the dock follows the composer, not its content

DSH's dock CSS derives its width from the composer rather than from its text:
`width: calc(100% - 2*var(--dsh-composer-side-clearance) - 2*var(--dsh-composer-dock-inset))`,
`max-width: calc(var(--dsh-composer-card-max-width) - 2*var(--dsh-composer-dock-inset))`, `margin: 0 auto`, with
`--dsh-composer-dock-inset: 8px`, `--dsh-composer-side-clearance: 16px` and
`--dsh-composer-card-max-width: calc(var(--dsh-chat-content-width) + 32px)` measured live. Heddle's bar was
`width: fit-content` (660px) centred inside a 796px composer card: narrower than the input and not aligned to
its edges. It now takes the composer card's own width formula (`min(calc(100% - 8px), calc(var(--chat-column) +
32px))`, `margin: 0 auto`), so the bar's left and right edges are the input's — measured after the fix at
796px, x aligned to the card, and asserted by the part 9 test. Kept difference, recorded: DSH's **visible inner
pill** still hugs its content inside that composer-width dock (its measured pill was 680px inside a 929px
dock); the owner asked for the visible bar itself to follow the input area, so Heddle fills the composer width
and aligns to it.
