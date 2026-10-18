---
title: DSH Input Area — recon for porting to Heddle
version: 1.0.0
description: What the DSH Web UI's input area renders and how it is sized, measured in a real browser, with the values Heddle now implements beside the ones it deliberately does not.
grounded_in:
  - source: browser
    detail: DSH session input-renderer at http://127.0.0.1:8080/, measured 2026-10-17 with getComputedStyle, at a 1200×1223 viewport
  - source: browser
    detail: the same measurements taken on Heddle's page at http://127.0.0.1:8082/ on 2026-10-17, for the comparison table
---

# DSH Input Area — recon

Measured by driving the DSH Web UI in a browser and reading computed styles and boxes, not by reading
its source. Every number below is a `getComputedStyle` value or a `getBoundingClientRect()` width at a
**1200×1223** viewport with the session sidebar 280px, so it can be re-derived rather than trusted.

## Geometry: one column, and the input hangs over it

| Thing | Measured value |
|---|---|
| conversation content area | **920px** wide (x=280) |
| text column (`--dsh-chat-content-width`) | **680px** — `clamp(680px, calc(920px * .64), 920px)` |
| a message row | 680px wide at x=397 |
| composer card | **712px × 98px**, at x=381 — the text column **+ 32px**, 16px over each side |
| composer seat (the whole strip) | 913px |

The relation is the useful part: the card is not a width of its own, it is **the conversation column plus
its side clearance**, so the input and the prose share one measure.

## The card

- `border-radius: 28px`
- `background: rgb(44, 44, 46)` (#2c2c2e)
- no border; a hairline ring instead —
  `box-shadow: 0 0 0 .5px rgba(255,255,255,.12), 0 4px 16px rgba(0,0,0,.03), 0 0 24px rgba(0,0,0,.03)`
- `padding: 8px 0 0`

## The editor

- a `contenteditable` div, transparent, no border
- box **708 × 36px** for one line
- `padding: 4px 8px 0 14px`; `font-size: 14px`; `line-height: 24px`
- caret `rgb(122, 170, 255)` (#7aaaff)
- placeholder text: `Message or run a task, / commands, @ files or sessions`
- the scroll container caps growth at **336px**, then scrolls

## The control row, inside the card

| Control | Measured |
|---|---|
| `+` (files or commands) | 28×28 circle, `background: rgb(53,54,56)` (#353638), radius full, 13.3px glyph |
| access mode | 117–153×28, 13px, `rgb(207,211,214)` (#cfd3d6), radius 8px, shield glyph; names `Full access` / `Workspace Write` |
| model selector | 189×28, 13px, `#cfd3d6`, radius 8px; label is **model + reasoning effort** (`DeepSeek-V41-Flash High`) |
| voice | 28×28, 12px glyph |
| send / stop | 34×34 circle, `background: rgb(122,170,255)` (#7aaaff), white glyph; a running turn swaps Send for **Stop** in the same place |

A new-session ("hero") state adds two controls above the card: a workspace picker (94×28) and an agent
preset (149×28), and centres the card vertically; a running session pins it at the bottom over a 36px
gradient fade.

## Below the card

A row of 12px pills in `rgb(173,178,184)` (#adb2b8): `20 turns 550 steps · 209 tok/s`,
`216M tok · Cache hit 99%`, `26% context`. They are measurements the host reports, not decoration.

## The resizable column

A **10px** strip with `cursor: col-resize` sits at the column's edge (measured at x=366 in the body);
dragging it changes `--dsh-conversation-column-width`, and the text column and composer follow because
both are derived from it.

## What Heddle implements, and what it does not

Measured the same way on Heddle's page after the port:

| Claim | Heddle |
|---|---|
| one card, radius 28, #2c2c2e, hairline ring + soft shadows | yes |
| card = text column + 32, centred | yes (measured 896 vs 864 at a 1200 viewport) |
| editor 14/24, grows to 336px, no manual resize | yes; padding is `4px 8px 8px 14px` rather than `4px 8px 0 14px` |
| capability-hinted placeholder | yes (`Message or run a task, / commands, @ files or sessions`) |
| `+` entry | yes — a file-path menu fed by `/api/tree` |
| access chip | **yes as a control** since 2026-10-17 — shield glyph, mode name and chevron opening the three-mode menu with a risk gate for full access; the mode is a session fact (`permission/mode` in its log), and `Auto review EXP` is not ported because heddle has no auto-review substrate. Measured in [`dsh-permission-modes.md`](dsh-permission-modes.md) |
| model + effort label | yes — the model's display name with its reasoning effort in the caption tone, the two-span anatomy measured above. Each configured endpoint lists the model types it offers and, per model, the reasoning levels its route was verified to accept; the level's own provider wire value is what the turn sends, and an endpoint/model that declares no levels shows no effort. The two-level seat and menu (root `Model`/`Effort` rows, endpoint-grouped model list, search, effort pane) are measured in [`dsh-model-selector.md`](dsh-model-selector.md) |
| send / stop swap | yes; Stop aborts the turn's `AbortController`, the abort reaches the provider connection, and the turn ends with `event: cancelled` |
| status row | turns and steps always; `tok/s` and `context %` only when the provider reported usage and the endpoint declares a `contextWindow`; nothing is invented |
| shared resizable column | yes — a 12px `col-resize` grip, keyboard operable, persisted in `localStorage` |
| agent preset / voice | no — Heddle has no preset or voice substrate, and the port adds no control that would not work |
