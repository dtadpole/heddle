---
title: Sidebar panel evidence
version: 1.0.0
description: The screenshots and measurements the sidebar-layout loop keeps, one per cycle, so a later round reads the evidence rather than reproducing it.
level: L2
status: unverified
grounded_in:
  - SIDEBAR_PANEL.md, the loop's own document
---

# Sidebar panel evidence

What belongs here: a screenshot per cycle of the panel in the state the cycle changed, named `cycle-<n>-<state>.png`,
and nothing else. The measurement tables stay in [`SIDEBAR_PANEL.md`](../../SIDEBAR_PANEL.md) beside the cycle that
produced them; this folder is only the picture a person can look at when the numbers and the screenshot disagree.

## Cycle 1

`cycle-1-scrolled.png` — the workspaces region scrolled to its end with 60 files in the workspace, at 1100×700. The
brand, `New session`, the workspaces header and the search field are exactly where they were before the scroll; the
panel's own scroll is zero. Before the change the same gesture moved the whole panel and took the search with it.

## Cycle 2

`cycle-2-settings.png` — the Settings dialog over the conversation at 1200×800: the Server section (sandbox mode,
working directory), four Models with `credential set` rather than a credential, the workspace roots, and the line that
says credentials are never shown. The panel's foot with its `Settings` entry is visible at the bottom edge, below the
scrolling workspaces region.

## Cycle 3

`cycle-3-region.png` — the workspaces region scrolled to its middle at 1100×700: the reserved 5-pixel bar on the right
edge and the 16 pixels of padding under the last row, the two facts cycle 1 had left to the platform. The panel's foot
and the conversation beside it are unchanged.

## Read next

[`SIDEBAR_PANEL.md`](../../SIDEBAR_PANEL.md) for the measured structure, the approaches that were discarded, and each
cycle's evidence block.
