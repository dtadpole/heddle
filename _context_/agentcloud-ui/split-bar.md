---
title: Agentcloud's split bar, measured
version: 1.0.0
description: The sidebar divider's hit area, affordances and transitions, read from the running agentcloud UI.
grounded_in:
  - source: browser
    detail: https://agentcloud.internalmeta.com/30f5bcd2-7c68-4626-b3d5-0b123be02e68, 2026-10-17
---

# Agentcloud's split bar

Measured in the browser, from the divider between the sidebar and the main panel:

- **Hit area**: an absolutely positioned, full-height div, **6px wide**, `cursor: col-resize`, `z-index: 10`,
  transparent background, no children, sitting on the panel edge.
- **Band** (`::before`): 6px wide, `background: rgb(from var(--color-text-primary) r g b / .1)` — 10% of the
  text colour — **opacity 0 by default**, `opacity: 1` on `:hover`, `:focus-visible` and while dragging;
  transition `opacity` with `--duration-agentcloud-resize-affordance` and the standard ease.
- **Grip** (`::after`): **2.5px** wide (`--panel-resize-grip-width`), `border-radius: 9999px`, colour
  `var(--color-border)`, **opacity 0 by default**, visible on hover/focus/drag, and on hover/focus its
  colour becomes `rgb(from var(--color-text-primary) r g b / .55)`; transition on background-color and
  opacity with the same duration.
- Both pseudo-elements are `pointer-events: none`; the 6px div itself is the target.
- Focus-visible mirrors hover: the band and the grip both appear, and the grip takes the 55% colour.
- The band's top and bottom are inset by the card inset + card radius (`--panel-resize-band-top/bottom`),
  a detail that only matters when the panels are rounded cards.

## What heddle copied

The 6px hit band, the 10% band, the 2.5px rounded grip in the border colour, the 55% text colour on
hover/focus/drag, the 120ms transition, and the hidden-until-near default. Heddle adds a **double-click
reset** to the layout's default width and keeps its existing arrow-key support; the visual states are
`#gutter-left::before/::after`, keyed on `:hover`, `:focus-visible` and `[data-dragging='true']`.

Evidence: [`../dsh-mechanisms/heddle-split-bar.png`](../dsh-mechanisms/heddle-split-bar.png) shows heddle's
band and grip while dragging.
