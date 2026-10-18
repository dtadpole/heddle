---
title: Sidebar panel
version: 1.0.0
description: How the left navigation panel is divided — what stays put, what scrolls, and the bottom settings area — measured against the reference and kept as the loop's memory.
level: L2
status: unverified
grounded_in:
  - owner statement 2026-10-17 that the panel must not scroll as a whole, that the workspaces portion should scroll, and that a bottom area should hold Settings and configuration
  - DSH 0.2.0-rc.2 driven in a browser on 2026-10-17, sidebar measured with getComputedStyle and getBoundingClientRect at 1400x900
---

# Sidebar panel

The owner's report: the whole left panel scrolls, so the controls above and below the list leave the screen with it.
The reference keeps one region scrollable — the workspaces — and pins everything else. This document is the loop's
memory: one block per cycle, re-readable in one sitting, so a later round or a restarted process resumes rather than
repeats.

## The reference, measured

DSH at `127.0.0.1:8080`, 2026-10-17, window 1400x900 (viewport 813 tall):

| Element | Box | y | `overflow-y` | scroll / client |
|---|---|---|---|---|
| sidebar column | 280×813 | 0 | **hidden** | 813 / 813 — the pane never scrolls |
| brand row | 216×24 | 24 | hidden | — |
| `New session` | 252×38 | 70 | hidden | — |
| `Plugins` | 252×36 | 120 | visible | — |
| `Automation tasks` | 252×36 | 160 | visible | — |
| **workspace list** | 270×461 | **246** | **auto** | **756 / 461** — the one scroller |
| Mobile access | 155×42 | 711 | hidden | — |
| Settings | 260×42 | 761 | hidden | — |

So: the pane is a fixed column; the brand, the primary action, the global rows, the workspaces header and search are
above the scroller and do not move; the workspaces list is the only element with its own scroll; the last two rows are
anchored to the bottom edge.

## Cycle 1 — the pane stops scrolling, and the workspaces region takes over

**measured:** above. Heddle's own aside, same window: 352×813, `overflow-y: auto`, **scrollHeight 1233 against
clientHeight 813** — the whole pane scrolls; the tree is 328×986 at y=201 and runs off the bottom.

**brainstorm:**

1. **Flex column with one scrolling middle** — `aside` becomes `display:flex; flex-direction:column; overflow:hidden`;
   a single wrapper around the tree gets `flex:1; min-height:0; overflow-y:auto`. Top and bottom are `flex:none`.
   *Chosen:* it is the reference's own shape, and the scroll region is the element that varies in length.
2. **Keep the pane scrolling and make the chrome `position: sticky`.** *Discarded:* the scrollbar still belongs to the
   pane, so the panel still scrolls as a whole — the exact thing the owner asked to stop — and sticky chrome paints
   over the rows it covers.
3. **CSS grid `auto auto 1fr auto`.** *Discarded:* the same mechanism with an extra concept; the page already uses flex,
   and a grid would be a second layout language beside it.
4. **`max-height: calc(100vh - chrome)` on the tree.** *Discarded:* magic numbers that drift the moment a row above
   changes height; a flex column derives the same number.
5. **Virtualise the list.** *Discarded:* a tree of a few hundred rows is not the problem, and virtualisation breaks the
   keyboard walk, the ARIA tree and the remembered expansion.

**understand:** the reference splits the panel because its content is variable-length and its chrome is not: the
controls are how a reader navigates at all, so they must not leave the screen. Heddle has **none** of the mechanism
today — no inner scroller, and no bottom row either. The scroller is a fix; the bottom row is a **feature** this
project does not have. The skill says a fix that needs a missing feature is bigger than one cycle: cycle 1 is the
scroller, cycle 2 the bottom row, cycle 3 the review.

**step back:** the objective is unchanged, but the job is two mechanisms rather than one, so the cycles are cut that
way. "Settings and configuration" is a feature with no UI in this project yet — it belongs to cycle 2 with its own
measurement of what a config surface may show (the endpoint file holds a credential and is never rendered). Sibling
check: the same "slow-growing content scrolls the pane" shape exists in `main` (the transcript), where it is already
`overflow: hidden` with its own scrolling log — so the sidebar is the only pane that got this wrong.

**plan:**

- `aside`: `display:flex; flex-direction:column; min-height:0; overflow:hidden`; keep the padding and width.
- one wrapper `#workspace-scroll` around the tree, the search results, the tree note and the adopted-folders section;
  `flex:1 1 auto; min-height:0; overflow-y:auto; overflow-x:hidden`.
- the rows above it stay `flex:none`, so they cannot be compressed away.
- the collapsed rail hides the wrapper with the rest of the words.
- judged by a browser check that seeds enough rows to overflow, scrolls the region, and asserts the aside is not
  scrollable while the chrome's position is unchanged — plus unit contracts for the structure.

**changed:** `src/server/page.html` — `aside` becomes a flex column with `overflow: hidden`; a new
`#workspace-scroll` wrapper holds the tree, the search results, the tree note and the adopted folders and is the only
`overflow-y: auto` element; the rows above it are `flex: none`; the collapsed rail hides the wrapper.
`_verifiers_/87-resizable-panels/check.mjs` — seeds 40 files so the region overflows and judges the structure;
`test/page-contract.test.ts` — six contracts for the wrapper, the column, the chrome's `flex: none` and the rail.

**evidence:** the same probe before and after, at 1100x700, with 60 files in the workspace.

| | before | after |
|---|---|---|
| `aside` | 352×613, `overflow-y: auto`, **scrollHeight 1233 / client 813** | 352×613, `overflow-y: hidden`, **613 / 613** |
| scroll containers in the panel | the aside itself | **`["workspace-scroll"]`**, 328×396, scrollHeight 2142 |
| scrolling the list | moved the whole panel | `scrollTop` 1746, brand y 12, `New session` y 78, search y 166 — **unchanged** |
| page / aside scroll after | — | `asideScrollTop: 0`, `pageScroll: 0` |

Screenshot: `.heddle-tmp/sidebar-after.png` (the scrolled region, chrome in place). The assertion that proves it: part
11's `the panel is a fixed column` / `the workspaces region is the only thing that scrolls`, shown to fail against the
old CSS (the aside reported `auto` and `asideScrolls: true`; the region did not exist).

**reds:** none in this cycle. The full sweep passed before this change (15 parts) and is re-run at the end of the
cycle.

**coverage:** the panel's chrome (brand, primary action, workspaces header, search) and the region were measured; the
**bottom area is not implemented yet** — that is cycle 2, and it is the reason this cycle changed no bottom edge.

**invariants:** the rail still hides the tree and the search (asserted in part 11); the scrollbar is `auto`, not
`always`, so a short list shows no gutter; horizontal overflow is clipped, so a long label is ellipsised in its row
rather than producing a second scrollbar; the page reports no errors (the probe reads `window.__probeErrors`).

**lessons:** the browser check has to wait for the tree's own fetch before measuring a region whose height depends on
it — a scroll claim on an empty list passes or fails for the wrong reason.

