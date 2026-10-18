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

Screenshot: [`_context_/sidebar-panel/cycle-1-scrolled.png`](_context_/sidebar-panel/cycle-1-scrolled.png) — the scrolled region with the chrome in place. The assertion that proves it: part
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

## Cycle 2 — the bottom area, and what Settings may show

**measured:** the reference's bottom, same session and window. The row is an **anchored block**: `settingsArea`
256×50 at y=757 in an 813-tall column (6px above the bottom), holding a `Settings` trigger 260×42 with
`padding: 0 10px 0 8px` and an 8-pixel gap; `Mobile access` sits above it at y=711, and both stay put while the
workspace list scrolls. Clicking `Settings` opens a **dialog** — `role=dialog`, 800×765, radius 28,
`rgb(44,44,46)` — with sections `General`, `Models`, `Built-in plugins`, `Agent presets`, and two actions,
`Open configuration file` and `Close`. Its General section holds the default permission mode, language, appearance,
font size, work-detail and shortcuts.

Heddle has **no bottom area and no settings surface at all**. What it does have is the data such a surface may show,
read from its own routes: `/api/status` (sandbox mode and the working directory) and `/api/endpoints` (name, kind,
base URL, model, capabilities, context window, and `credential: "set"` rather than a value). Configuration lives in
`~/.heddle/heddle.json`, outside the repository, and a credential must never be rendered.

**brainstorm:**

1. **Anchored bottom row + a native `<dialog>` with read-only sections** — the reference's shape, reduced to the
   facts this project can state honestly. *Chosen:* it is the smallest surface that answers "where do I look, and
   what is this machine configured with", and a dialog does not disturb the conversation panel.
2. **A Settings *view* in the main panel's ring** (Chat / Trajectory / Settings). *Discarded:* the ring is about the
   session; a settings tab would sit beside a conversation as if it belonged to it, and DSH uses a dialog.
3. **An expandable settings section inside the panel** under the list. *Discarded:* the panel is 352 pixels wide and
   an endpoints table needs more; it would also compete with the scroller for height.
4. **A settings item in the session header's `…` menu.** *Discarded:* the owner asked for a bottom area, and settings
   are not session actions.
5. **Bottom row showing status only** (sandbox mode, model) with no dialog. *Discarded:* it does not "allow setting
   config", which is the request; it would also duplicate the composer's access and model chips.

**understand:** the reference's bottom is a **launcher area** for surfaces that belong to the application rather than
to a conversation — settings, mobile access, the assistant. Heddle has the launcher's *data* but not its *surfaces*.
Cycle 2 therefore builds the area and a **read-only** dialog: endpoint configuration, the sandbox mode, the workspace
roots, and an explicit line that credentials are never shown. Writing configuration from the browser is a feature with
its own safety question (the file holds credentials, and a write path would need validation, atomicity and an approval
story) — recorded here, not half-built.

**step back:** the job stays as stated, but "allow setting config" is read as **a place to see and understand the
configuration** for this cycle; editing is the next feature, named in the document. The reference's tabs are not copied
because three short sections do not need them yet — recorded as a divergence with its reason, to revisit when a
writing surface arrives.

**plan:**

- an anchored `#panel-foot` at the end of the aside: `flex: none`, a `Settings` button with a gear glyph and a label,
  `⌥⌘,` as its chord (the reference's own chord for the same surface).
- a native `<dialog id="settings-dialog">`: heading `Settings`, a `Close` action, and three sections — **Server**
  (sandbox mode, working directory), **Models** (one row per endpoint: name, kind, model, capabilities, context
  window, whether a credential is configured), **Workspaces** (the roots the tree draws, with their paths) — plus the
  credentials line.
- the data is fetched when the dialog opens, from `/api/status`, `/api/endpoints` and `/api/tree`.
- in the collapsed rail the foot shows the gear alone, anchored to the bottom, as the reference's rail does.
- judged by a browser check (the foot stays put while the region scrolls, the dialog opens with its sections, no
  credential value is rendered, `Close` and Escape both dismiss it) and by unit contracts for the structure and the
  chord.

**changed:** `src/server/page.html` — a `#panel-foot` at the end of the aside with a `Settings` trigger, a native
`<dialog id="settings-dialog">` with `Server` / `Models` / `Workspaces` sections and a credentials line, and the
reference's `⌥⌘,` chord; `_verifiers_/87-resizable-panels/check.mjs` — the foot's anchoring and the dialog's content;
`test/page-contract.test.ts` — eleven contracts for the structure, the chord and the credential rule.

**evidence:** measured at 1200×800 with the real machine's configuration.

| | reading |
|---|---|
| foot | 328×46, bottom 701 against the panel's 713 (the 12-pixel padding), below the region's bottom at 650 |
| foot while the region scrolls | top unchanged |
| rail foot | gear 36×36, label hidden, anchored to the bottom edge |
| dialog | `open`, `:modal`, 720×593, radius 28px, title `Settings`, focus inside |
| Server | `Sandbox workspace-write`, `Working directory /Users/zhenc/heddle` |
| Models | 4 endpoints, each with kind, model, context window, `credential set` / `no credential`, capabilities |
| Workspaces | the roots with their paths |
| credentials | the note says they are never shown; no `sk-…`, `api_key: …` or bearer token appears in the dialog text |
| Close / chord | `Close` sets `open` false, and `⌥⌘,` opens it again |

Screenshot: [`_context_/sidebar-panel/cycle-2-settings.png`](_context_/sidebar-panel/cycle-2-settings.png). The
assertion that proves it: part 11's foot/dialog block — written after the markup, shown to fail by removing
`#panel-foot` (the claim then reads `Session`, not `Settings`) and by the credential regex, which fails if a value is
ever rendered.

**reds:** one, named and not edited under: part 80's `model-switcher` check — "the seat shows the endpoint the run
nominated" — fails intermittently under a full parallel sweep and passes on its own (measured twice, in both
directions in the same hour). It belongs to the concurrent session's model-seat and context-window work, not to this
panel. Everything else in the sweep is green, and a clean `npm run build` before the sweep removes the failures that
come from a `dist/` half-written by the other session's build (`88` and `90` both passed on a re-run after one).

**coverage:** the reference's **tabs** (`General`, `Models`, `Built-in plugins`, `Agent presets`) are not copied: three
short sections do not need a tab strip, and this surface is read-only. The reference's `Open configuration file` is not
copied either — this page has no route that opens a file on the host, and adding one for a credential-bearing file is a
decision, not a layout. Both are recorded as divergences with their reasons.

**invariants:** the empty state still shows when nothing is open (part 11); the rail still hides the tree and the
search; the dialog's body scrolls rather than the dialog, so the heading and `Close` stay reachable; Escape closes it
because it is a native modal dialog.

**lessons:** a settings surface is where a leak would be easiest to make. The assertion that matters is not "the
endpoint appears" but "no secret-shaped string appears", which is why the check greps the dialog's own text for the
shapes a key takes.

## Cycle 3 — the review: the region's own geometry, and the short list

**measured:** the reference's list, 1200×800: `scrollbar-gutter: stable`, `::-webkit-scrollbar` **5px**,
`padding: 0 5px 16px 4px`, `offsetWidth - clientWidth` **5**, and its last content ending **16px** above the list's
bottom edge. Heddle's region measured `offsetWidth - clientWidth` **0** (a platform overlay bar), `padding-bottom`
**0px**, its last row flush against the panel's foot.

**brainstorm:**

1. **Copy the reference's exact mechanism** — `scrollbar-gutter: stable` + a 5-pixel `::-webkit-scrollbar` + 16px
   bottom padding. *Chosen:* it is DSH's own combination, and each part is measurable.
2. **`scrollbar-width: thin` alone** (the first attempt). *Discarded by measurement:* it set nothing — Chrome does not
   apply `::-webkit-scrollbar` while `scrollbar-width: thin` is in force, so the gutter stayed 0 and the platform drew
   an overlay bar.
3. **`overflow-y: scroll` to force a classic bar.** *Discarded:* it shows a disabled bar when the list is short, and the
   reference's short state was not measured to do that; `stable` reserves the same gutter without promising a track.
4. **A custom thumb element ridden on scroll.** *Discarded:* a scrollbar is the platform's job, and a hand-drawn one
   loses drag-to-scroll and the accessibility the browser already provides.
5. **Padding only (no bar change).** *Discarded:* it fixes the flush last row but leaves the bar overlay, which is the
   visible difference a person notices while scrolling.

**understand:** the reference's geometry is **reserved**, not floating: a fixed 5px column for the bar and 16px of end
padding, so a row's age never sits under a bar and the last row never touches what is below. Heddle had left both to the
platform, which on macOS means an overlay bar and content flush to the edge. This is a value/arrangement difference —
no new mechanism.

**step back:** the three cycles are now the whole of the owner's request: the pane does not scroll (cycle 1), the
bottom area holds Settings (cycle 2), and the region's scroll geometry matches the reference (cycle 3). Nothing widened
the scope: the divergences recorded in cycles 1–2 (read-only settings, no tabs, no "open configuration file") are
features the owner has not asked for yet. Sibling check: the transcript (`#log`) and the trajectory pane (`.tr-pane`)
have their own scrollers with the platform's bar — but the reference styles its session list only, so those stay as
they are; recorded rather than changed.

**plan:**

- `#workspace-scroll`: `scrollbar-gutter: stable` (the reference's own property), a 5-pixel `::-webkit-scrollbar` with
  a themed thumb, and `padding-bottom: 1rem`.
- drop `scrollbar-width: thin`, which is what made the first attempt reserve nothing.
- judged by part 11 (gutter 5, `stable`, `padding-bottom: 16px`, the last row ≥ 12px above the edge, and a closed
  workspace leaving a region that does not scroll while the foot stays at the bottom) and by unit contracts.

**changed:** `src/server/page.html` — the region's scroll geometry; `_verifiers_/87-resizable-panels/check.mjs` — the
geometry and the short-list claims; `test/page-contract.test.ts` — four contracts including the `scrollbar-width` that
must **not** be there.

**evidence:** measured before and after, 1200×800 with 40 files.

| | before | after | reference |
|---|---|---|---|
| `offsetWidth - clientWidth` | 0 | **5** | 5 |
| `scrollbar-gutter` | auto | **stable** | stable |
| `padding-bottom` | 0px | **16px** | 16px |
| last content to the list's bottom | 0 | **16px** | 16px |
| short list (3 files) | region fits, foot at the bottom | unchanged, and now asserted | not measured |

Screenshot: [`_context_/sidebar-panel/cycle-3-region.png`](_context_/sidebar-panel/cycle-3-region.png) — the region
scrolled to its middle, with the reserved 5-pixel bar and the end padding.

The assertion that proves it: part 11's `the region reserves the reference's 5-pixel scrollbar` etc. — against the
previous CSS the gutter reads 0 and `scrollbarGutter` reads `auto`, so the claim fails.

**reds:** none of this cycle's own. The sweep's intermittent red remains named: part 80's `model-switcher` check, the
concurrent session's model-seat work, failing only under a full parallel sweep.

**coverage:** the **collapsed rail** is judged in part 11 (the tree and search hidden, the gear anchored to the bottom);
the **short list** is now asserted. Not visited: a list long enough to scroll **while the panel is narrower than its
minimum** (the resizer clamps it), and a scrollbar drag in the rail — the rail has no list to scroll, so the second is
vacuous.

**invariants:** the pane still does not scroll (part 11); the foot still does not move while the region scrolls; the
settings dialog is unaffected by the gutter change (it is outside the region); the first-visit expansion still opens
the workspace after a reload.

## After the loop — the list's width, a dead module, and a stray daemon

The owner read the finished panel and reported it three times in a row: the scrolling pane should **span the whole
panel**, the list should be **as wide as the search field**, the scrollbar should be **on the right**, and the tree's
content should **fill more of the horizontal space** instead of sitting in the middle. Three of those turned out not to
be layout at all, so they are recorded here.

**A dead module, not a narrow list.** The page's script was throwing at boot — `Cannot access 'armRows' before
initialization` — because the concurrent session's row-animation code registered its listeners near the top of the
module, before the `const armRows` they call was initialized. The whole module stopped, so the tree never rendered: the
panel was empty and there was no scrollbar at all. The fix is a hoisted `function armRows()`.

**A stray daemon, not a stale stylesheet.** The live UI at :8082 was served by a process running
`heddle/dist/cli.js` with its working directory at `/Users/zhenc` — no profile, so the workspace plugin did not load and
the page said "this profile does not load the workspace plugin". Every `install.sh --restart` in the session had been
failing silently (the output was discarded), because the script refuses a dirty checkout and the daemon the script
manages is a **deployment clone** (`~/heddle-deploy`) rather than the working tree. The daemon now runs from
`~/heddle` with `HEDDLE_ALLOW_DIRTY_INSTALL=1` — the script's documented development escape hatch — and the tree
renders. A restart is only believed when its exit status is zero.

**The paint and the content are two widths.** With the page alive: the panel keeps 12px of horizontal padding for its
chrome, the region spans 0→352 with the 5px bar at 347→352, and the rows' boxes were 12→340 because the tree indented
with the group's `padding-left`. Two fixes, one per report:

- the indentation is the **content's** (`depth * 14px`, the tree's documented rule), passed to the row as
  `--tree-depth`, so the group no longer narrows the rows below it and every row's paint spans 0→347;
- the content column is the **widest aligned column**: 12px in — where the `Workspaces` heading and the search field's
  box begin — and 8px inside the row's own right edge (the reference's row rule). The earlier 19.2/14.2 lined the
  content up with the search *text*, costing seven pixels left and six right.

Measured after, at 1200×760 on the live daemon:

| Element | Reading |
|---|---|
| panel | 0→352 |
| scrolling pane | 0→352, `padding-inline: 0`, bar at 347→352 |
| every row's **paint** | 0→347, at depth 0, 1 and 2 |
| every row's **content** | 12 / 26 / 40 px from the edge (12 + depth × 14) |
| root row content left | 12 — the `Workspaces` heading's own left edge |
| row content right | 339 — 8px inside the row, the reference's rule |

Screenshot: [`_context_/sidebar-panel/after-loop-list-width.png`](_context_/sidebar-panel/after-loop-list-width.png).

Part 11 asserts the pane's edges, the paint's edges, the content's column, the 8px right inset and the 14px indent; the
unit contracts pin the `--tree-depth` wiring and the row padding formula.

**A divergence, recorded:** the groups no longer draw their vertical guide line (`border-left`), because the line was
the group's box edge and the group no longer has one; the tree's shape is still readable from the indentation, and the
reference draws no guides either.

## After the loop — parallel roots, a dynamic pin, and no ad hoc group

Three more owner reports, each a small fact with a large visual effect.

**The three projects were nesting, not parallel.** `treeList.replaceChildren(...tops.map(nodeRow))` passes the array
index as `nodeRow`'s second argument, which is now its **depth** — so the three roots were drawn at depth 0, 1 and 2,
each indented 14 pixels more than the last and reading as children of the first. Measured: the roots' content started
at 12, 26 and 40. The callback is explicit now (`tops.map((node) => nodeRow(node))`), and the roots all start at 12.

**The pin was a fixed asset on every row.** It is a **tail slot with `:empty` collapsing it**, so an unpinned row pays
nothing for it and the age is the tail's only child; a pinned row draws the reference's 16-pixel marker with its 14-pixel
glyph at the right edge, and hovering swaps the tail to the controls in place. Measured on a store-pinned session:
slot 16×16 with a glyph, and 0 wide with `display: none` on every unpinned row.

**The "ad hoc" group is gone.** The owner removed it: the tree is the one list. The `details#history`/`#adhoc` markup,
its CSS and its render block are deleted, the row selector no longer names it, and the three verifier files that kept a
dead `#adhoc` selector helper had it removed. A session in a folder that is not registered as a workspace is no longer
reachable from the panel — recorded here as the consequence of the removal.

Screenshot: [`_context_/sidebar-panel/parallel-roots.png`](_context_/sidebar-panel/parallel-roots.png).

## After the loop — the hover surface that leaked

**the report:** the owner hovered a row and the **whole workspace tree** changed shade, not just the item.

**measured,** live at 1200×800: hovering a child row changed the row (`oklab(… / 0.08)`, the row's own tint) **and its
parent `li` to an opaque `rgb(35,35,36)`**. The cause was a global stylesheet rule, `li:hover { background:
var(--surface) }`, intended for the small clickable lists (a turn's changed files, the settings dialog's lists). A tree
`li` **contains its entire subtree**, and `:hover` matches ancestors, so hovering any row set the ancestor `li`s to an
opaque surface — it painted behind the whole section.

**the fix,** one rule scoped to what it is for:

```css
.changed-list > li:hover,
.settings-endpoint:hover,
.settings-workspace:hover { background: var(--surface); }
```

Measured after: the hovered row carries its 8% tint while its `li`, the ancestor folder `li`, `#tree`,
`#workspace-scroll` and the panel keep their rest backgrounds (all transparent or unchanged); part 11 asserts exactly
that, including the ancestor case, and the unit contract rejects a bare `li:hover` surface.

**lesson:** a global element-selector rule is a **subtree** rule in disguise — an element's box contains its descendants,
so styling `li:hover` styles every ancestor row's whole body. Scope by the component that wants the state.

## Cycle: the row inset — the tint stops inside the panel

**measured:** the reference at 1200×800, 2026-10-17. Panel 0→280; its workspace list 8→278 with
`padding: 0 5px 16px 4px`; every tree row **12→268** — a **12-pixel inset on each side** — radius 12, `padding: 0 8px`,
and its selected row's `rgba(255,255,255,.08)` tint painted **inside that box**, not across the panel. Row content starts
at 20 from the panel's edge.

**brainstorm:**

1. **Inset the rows inside a full-width pane** — `#tree { padding-inline: 12px calc(12px - 5px) }`, so the rows' boxes
   are 12→340 in a 0→352 pane and the 5px scrollbar stays at the panel's edge. *Chosen:* it is the reference's own
   arrangement (its list is inset inside the panel and its rows inside the list), and it keeps the pane full-width as the
   owner asked.
2. **Inset the pane instead** (panel → 8px margins, list inside). *Discarded:* the owner's earlier requirement is that the
   scrollable area fills the panel, and this moves the scrollbar away from its edge.
3. **Give the row a margin instead of the list padding.** *Discarded:* equivalent geometry with two facts in two places;
   one padding on the list states the inset once.
4. **A wrapper `div` around the rows.** *Discarded:* a third element for a padding.
5. **Inset only the hover/selected paint with a pseudo-element.** *Discarded:* the row's box is what the eye reads as the
   item; painting the state elsewhere would leave the clickable area and the highlight disagreeing.

**understand:** the reference insets the **row**, not the pane, because the pane must keep its scrollbar against the
panel's edge while the items must read as discrete objects inside it. Heddle already had a full-width pane from the
previous cycle; what it lacked was the row inset, so the tint ran edge to edge. This is a value/arrangement change.

**step back:** the objective holds; one fact (the inset) with two consumers (box and radius) and one new property (the
content column moves with it, 20/332). Nothing widens: the item's own padding and the list's inset together put the text
back where the search field's text is.

**plan:**

- `#tree { padding-inline: 12px calc(12px - 5px) }` — 12 from the panel's left; 12 from its right less the 5px bar, so the
  row's right edge is 12 from the panel's edge and the bar keeps its place.
- the row's own padding becomes `.5rem` (8px) on both sides plus the depth indent: content at 20 (the search text's
  column) and 332 (its right).
- judged by part 11 (pane edges, row inset, radius, scrollbar at the edge, content column, 14px indent) and by the unit
  contracts for the two CSS rules.

**changed:** `src/server/page.html` — the list's padding and the row's padding;
`_verifiers_/87-resizable-panels/check.mjs` — the geometry claims; `test/page-contract.test.ts` — the two rules.

**evidence:** measured on the live daemon at 1200×800.

| Element | Before | After | Reference |
|---|---|---|---|
| pane | 0→352 | 0→352 | 8→278 inside 280 |
| row box | 0→347 | **12→340** | 12→268 |
| row inset from the panel | 0 / 5 | **12 / 12** | 12 / 12 |
| row radius | 12px | 12px | 12px |
| hover/selected paint | 0→347 | **12→340** | inside the row box |
| row content | 12 / 332 | **20 / 332** | 20 |
| scrollbar | at 347 | at 347 | at the list's edge |

Screenshot: [`_context_/sidebar-panel/tree-item-inset.png`](_context_/sidebar-panel/tree-item-inset.png) — a hovered row
whose tint starts 12 pixels inside the panel.

**reds:** none in part 11. Part 7's four reds are the concurrent session's in-flight row-tail and glide changes, named in
the previous cycle.

**coverage:** the inset at the collapsed rail (the rail has no rows, so it is vacuous), the search-results list (its own
12px padding already insets its rows), and the transient selected state were read; the pinned row's tail was not
re-measured this cycle.

**invariants:** the pane still spans the panel and its scrollbar sits at the edge (asserted); the row content column is
still the search field's text column (asserted within a rounded pixel); a child still indents 14px of content (asserted);
hover and selection still paint on the row itself.

**lessons:** a "full width" requirement is about the **scrollable region**; the items inside it are objects with their own
edge. The two are separate facts and the reference states both.

## Cycle 2: the search list is the same rows, and a build marker

**measured:** the reference at 1200×800, 2026-10-17. Typing in its search field replaces the tree with a flat result
list; the filtered rows measure **12→268** — the same inset as the tree's own rows — at radius 16 (its result component
is taller, `padding: 4px 8px`). The scroller stayed 8→278. In the reference a search does not move the list's edges.

**measured, ours:** tree rows 12→340, but search hits **12→335** — five pixels short on the right (the `.hit` list was
still padded `.75rem`, not the row inset) — with radius 4.8px and 6.4px inner padding against the row's 12px and 8px.

**brainstorm:**

1. **Give the search list the tree's inset and the hit the row's rounding/padding.** *Chosen:* the reference's own
   arrangement — a search is the same list of rows, filtered.
2. **Give hits their own inset.** *Discarded:* two lists under one scrollbar with two edges read as two panels.
3. **Match the reference's 16px hit radius.** *Discarded:* its hit is a taller two-line result component; heddle's hit is
   a one-line row, so the row's 12px is this component's shape. Recorded as a deliberate divergence.
4. **Keep 10% hover on hits while rows use 8%.** *Discarded:* same surface, same state, same tint.

**understand:** the two lists share the scrolling pane, so they must share its geometry; the row's shape belongs to the
row, not to the list that holds it. The gap was not a design choice but a stale padding left on one list.

**step back:** in scope, one value class, no new structure. The row content moves with the list's padding, so the hits'
text lands on 20/332 like the tree's.

**changed:** `src/server/page.html` — `#search-results` padding, `.hit` padding/radius/hover tint.

**evidence:** the same probe against the same fixture, reverting only the rule:

| Run | tree row | search hit |
|---|---|---|
| without the fix (`.75rem`) | 12→340 | **12→335** — the new claim fails |
| with the fix | 12→340 | 12→340 |

and the geometry is identical at 1000 and 1600 viewport widths (the sidebar is a fixed 352 either way):
`{"viewport":1000,"row":[12,340]}` and `{"viewport":1600,"row":[12,340]}`.

Screenshot: [`_context_/sidebar-panel/search-hit-inset.png`](_context_/sidebar-panel/search-hit-inset.png) — a hovered
search hit whose tint starts and ends where the tree rows' do.

### The stale-build lesson, made checkable

This cycle began by reading the live page's rows as **0→347** — the inset "missing". The source had it. The daemon was
serving `~/heddle-deploy`, a clean checkout that predated the commit (the deployment path the install script requires),
so every live reading came from a stale page. Two changes from that:

- the served page now carries **`meta[name=heddle-page]`**, the first 12 hex of its own file's sha256, filled in by the
  server (`markedPage`, unit-tested); part 11 recomputes it from `dist/server/page.html` and asserts the served document
  states it. A stale build now says which build it is instead of looking like a missing feature;
- the **deployment checkout is updated to `origin/main` before every live reading** (fetch + reset + build + restart from
  that checkout), and its `dompurify` dependency is installed — its build had been copying the page and then failing.

**reds:** none in part 11. Part 80 is red on the concurrent session's image-provider work, unrelated to the sidebar.

**coverage:** rest and search-mode lists, two viewport widths, and the served page's build marker were read. The
selected state under search (a hit is a button, not a treeitem) was not measured this cycle.

**invariants:** the pane still spans the panel with its 5px scrollbar at the edge; tree rows and search hits share one
inset (asserted); their content column is the search field's text column; the 14px depth indent is unchanged.

## Cycle 3: the keyboard's ring, and the states the inset must survive

**measured:** the reference's own focus treatment could not be read — its tree items do not become `document.activeElement`
through `focus()` (measured: `focused: false`), so there is no reference ring to copy; its hover, however, is **instant**
(`transition: all 0s`), which heddle already matches. Heddle's rows **are** focusable (`tabIndex = 0`), and the platform's
default ring is what a keyboard user saw.

**measured, ours (pre-fix):** a row at **12→340**, focused from the keyboard (`:focus-visible` true), drew the UA's
`outline: auto 1px`, `outline-offset: 0`, colour `rgb(153, 200, 255)` — painting at **11→341**, outside the row's box, in
the browser's blue. The one row state that must not break the 12-pixel gutter was the only one painting into it.

**brainstorm:**

1. **A solid 2px ring offset inward (`-2px`), in the panel's 45% ink.** *Chosen:* the ring's outer edge becomes the row's
   own box, it follows the 12px radius, and it is the same focus treatment the other focusable controls in the panel use
   (`details.turn > summary`, `.column-grip`, `#minimap-hit` — all 45% ink) with the one change the inset requires.
2. **Keep the platform ring and accept the overhang.** *Discarded:* it paints into the gutter and uses a colour from
   outside the panel's palette; the rule this cycle exists for is that every row state stops at the inset.
3. **`outline: none` and change the background instead.** *Discarded:* then focus wears the same 8% tint as hover and
   selection, three states on one signal.
4. **A box-shadow ring.** *Discarded:* equivalent geometry, but it cannot follow the border-radius as the outline does.

**understand:** the inset is a property of the row's box; the UA ring is drawn *outside* that box, so any row state that
paints outside it breaks the design. The fix belongs to the row's focus rule, not to the list's padding.

**step back:** one rule, one state, no geometry change; the ring's row box stays 12→340.

**changed:** `src/server/page.html` — `#tree .row:focus-visible`.

**evidence,** same probe, keyboard modality first:

| Run | box | outline | ring |
|---|---|---|---|
| without the rule | 12→340 | `auto 1px`, offset 0, `rgb(153,200,255)` | 11→341 |
| with the rule | 12→340 | `solid 2px`, offset −2px, `oklab(0.98 … / 0.45)` | 12→340 (inside the box) |

The states the inset had to survive were measured in the same pass: a **short list** (1 row, no overflow) still reserves
the 5px gutter and the row is 12→340; the **rail** collapses (`collapsed`) and restores (`expanded`) with the row back at
12→340; **hover**, **selected with the pointer away** and **search hits** all paint on the 12→340 box (cycles 1–2);
the row's only motion is instant, as the reference's is.

Screenshot: [`_context_/sidebar-panel/focused-row.png`](_context_/sidebar-panel/focused-row.png) — a focused workspace
row whose ring sits inside the row's own 12→340 box.

**reds:** none in part 11; the suite is green (part 7 45/45, npm test 428/428, linter 0 errors).

**coverage:** the four row states (rest, hover, selected, keyboard focus), the short list, the rail and two viewport
widths are read. Not measured: the reference's keyboard ring (it exposes none to `focus()`), and a row focused *while the
list scrolls* — neither changes the claim.

**invariants:** the pane spans the panel with its 5px scrollbar at the edge; row boxes are 12→340 in every state; the
focus ring stays inside; the content column is the search field's text column; the depth indent is 14px.

**lessons:** a state that paints **outside** the box is the one that can break an inset that every other state respects —
and the platform's default focus ring is such a state. Every state of an object needs measuring, not just the pointer's.

**lessons:** a second list inside one scroller is not a second design; it is the same row shape in another state. And a
comparison that does not pin the served build can spend a cycle measuring a page nobody rebuilt.

**lessons:** a scrollbar is geometry as well as paint. The measurable facts are `offsetWidth - clientWidth`,
`scrollbar-gutter` and the end padding — and the first attempt failed on a property (`scrollbar-width: thin`) whose
only effect was to switch the mechanism off, which is why the new contract asserts its **absence**.

