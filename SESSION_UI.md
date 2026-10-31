---
title: Session UI, as DSH does it
version: 1.1.1
description: What DSH's session management looks like in use, what Heddle does today, and the plan to close the gap.
level: L2
status: unverified
grounded_in:
  - source: DSH 0.2.0-rc.2 driven in a browser on 2026-10-17, session list and row actions observed directly
  - source: Heddle's own Web UI on the same day, same checks performed
---

# Session UI, as DSH does it

The owner asked for this comparison before any more UI work: drive DSH, watch what every control
does, write it down, then make Heddle behave the same. This file is the record and the plan. It is
**observed behaviour**, not documentation read from DSH — every line below was produced by clicking,
hovering or typing in the running UI on 2026-10-17, and the observations that decided a design point
say so.

## What DSH actually does

### The list

- **Sessions hang directly under their workspace.** No folder levels between them. A workspace row
  expands and collapses; the sessions are its first children.
- **A row reads `state · title · age`**: `Running session-mgmt now`, `Completed code 1min`,
  `context-mgmt 4d`. The state prefix (`Running` / `Completed`) and the relative age are part of the
  row; the title is derived from what the conversation is about, not from a clock or an id.
- **The selected row** is a filled row with the page title following it (`context-mgmt — DeepSeek
  Harness`), and the whole main panel switches to that session.
- **A pinned row** moves above every newer session in its workspace and its accessible name gains
  `Pinned` — a marker, not only an order.
- **A forked session** is named `<title> (1)` and appears beside its parent; forking does **not**
  navigate to it.

### The row's controls

- **Nothing is on the row until the pointer is over it.** Hover reveals, inline at the right edge:
  1. `Session actions for <title>` — the `…`, which opens the menu;
  2. `Archive session` — direct;
  3. `Pin session` (or `Unpin session`) — direct.
- The two direct buttons are the two acts frequent enough to skip the menu. Everything rare is behind
  `…`.

### The `…` menu

| Item | Shortcut | Behaviour observed |
|---|---|---|
| `Pin session` / `Unpin session` | — | label follows state; the row reorders and gains or loses its marker |
| `Rename` | `Alt+Meta+G` | inline rename of the selected session |
| `Fork session` | `Shift+Meta+F` | acts on the **selected** session, not necessarily the hovered one; creates `<title> (1)`; no navigation |
| `Archive session` | `Alt+Meta+A` | the row leaves the list; the log is untouched |

There is **no `Delete session`** in this menu.

### Search

- A `Search sessions` control (shortcut `Alt+Meta+K`) reveals a text field; typing **replaces the tree
  with a separate flat `Search results` tree**, each row reading `title workspace` — so a hit says
  which workspace it is in.
- A `Clear search` button restores the tree.

### View options

A `View options` menu with three groups, each a radio-ish list:

- **Grouping**: `WorkSpace` · `Workspace Tree` · `In one list`
- **Ordering**: `Manual` · `Last updated`
- **Archive visibility**: `Hide archived` · `All conversations (show archived)` · `Archived only`

### The session's own panel

- Tabs `Chat` and `Trajectory` only.
- A **Session hierarchy** breadcrumb of the session's title, then `N subagents`, `Agent Team`,
  `N background jobs`, `Open in Finder`, `More ways to open`, `More actions`.
- A footer of live facts: `25 turns 643 steps · 209 tok/s`, `226M tok · Cache hit 99%`,
  `33% of context used`.

The procedure this document is the output of now lives in the project's skills, so the next session runs the same
checklist instead of rediscovering it: [`_skills_/ui-parity-audit`](_skills_/ui-parity-audit/INDEX.md) holds the
instruments, the dimensions that have ever differed (including cursor affordance, the three states, order, names,
ARIA, keyboard and the periphery), and the table of misses already paid for. Its companion
[`_skills_/full-loop-goal`](_skills_/full-loop-goal/INDEX.md) says how a job of this size becomes a goal whose rounds
each produce evidence.

## The audit, surface by surface

Both UIs opened side by side on 2026-10-17; every row is a thing a person can point at, and each verdict is either a
measurement that matched, a fix, or a stated decision not to copy.

| Surface | DSH, observed | Heddle, after the audit | Verdict |
|---|---|---|---|
| Row's leading content | status word `Running` / `Completed` at x=28, then a tag (`[ui]`, `[feat]`, `[tool]`) and the title | the row's icon, then the title (type rows carry their badge) | **difference kept**: the tag is this UI's type badge; a running/completed word would need heddle's own stream state threaded into a tree row, which is a feature rather than a fix |
| Row's hover controls, order | `…` at x=192, `Archive session` at x=218, `Pin session` at x=244 | the same three in the same order, measured at x=206/229/254 | **fixed this round** — it was `Pin`, `Archive`, `…` |
| Row's age | right edge, 8px inside, muted 11px | same | match |
| Menu items, names | `Pin session`, `Rename`, `Fork session`, `Archive session` (reversed when set), with chords printed beside | the same four names; the chords work but are not printed | match on names, **difference kept** on printing the chords |
| Search | a field that replaces the tree with a flat result list, each row `title · workspace · age` | same, with Clear and Escape | match |
| View options | four groups: `WorkSpace` heading, `Workspace Tree` / `In one list`, `Manual` / `Last updated`, archive trio | the heading, both grouping items, `Last updated`, the archive trio — `Manual` left out (drag-to-order is a feature) | **mostly fixed this round**, after my earlier "three items" description was corrected by opening the menu |
| Panel header | session name at the column's left, chips for subagents/jobs, then tabs | session name, the folder it belongs to, then tabs | match in shape; the chips have no heddle mechanism behind them |
| Tabs | `Chat` / `Trajectory`, plus a turn-navigation strip in the chat | `Chat` / `Trajectory`; the turn strip lives in the Trajectory view | match in intent, **difference kept** in placement |
| Composer | 28px card, `+`, access, model, send, then a status line of turns/steps/tok-s/context | the same, same order | match |
| Shortcuts | `Alt+Meta+A/G/K`, `Shift+Meta+F` | the same four, bound to the selected row | match |
| Header's actions menu | `More actions` holding `Download session log` and `Feedback` | **added this round**: `More actions` holding `Download session log`; `Feedback` is DSH's product feedback, not a mechanism this repository has | **fixed** for the one item that is a session action; the route serves the log **decoded** as newline-delimited JSON — the disk's zstd frames would be a file nobody can open |
| Header's hierarchy nav | `role="navigation"` named "Session hierarchy", holding the tagged session name | the header's `<h2>` with the name and its folder | match in content; the nav element is DSH's own structure and this header is not a nav |
| Composer's controls | in one row: `+` / `Access mode, current: Full access` / `Select model, current <model>, reasoning effort High` / voice input / `Send message` | `+` / `Access mode, current: Workspace write` / `Select model, current <model>`, and `, reasoning effort <level>` where the model declares levels / `Send message` | **fixed** for the two names (they carry their value, as DSH's do); the effort half was added with the two-tier selector below; voice input has no mechanism here and is recorded as not built |
| Composer's model seat | DSH's two-level `Model` / `Effort` menu: the model list grouped by provider, the effort list per model, search above four models | the same shape, grouped by the **endpoint the user configured** in `~/.heddle/heddle.json` (the owner's two tiers: endpoint → model types), an Effort row only for a model that declares levels, and the level's provider wire value sent on the turn | **fixed** (workstream `feat/model-selector`): the measured comparison, its numbers and the divergences kept (material, accent, z-index, search ranking, no model-change transcript notice) are in [`_context_/dsh-mechanisms/dsh-model-selector.md`](_context_/dsh-mechanisms/dsh-model-selector.md) |
| View tabs | `role=tablist` with `role=tab` buttons, `aria-selected`, roving tabindex, arrow keys; **plain text** tabs — no background, border or radius, 13px/500, a **36px** gap between them, the selected one coloured `rgb(122,170,255)` with a **2px `::after` underline** in that colour, hover turning the label white | the pattern, but drawn as a bordered, tinted, rounded box | **fixed over cycles 1–2**: plain tabs, 13px/500, 36px gap, colour-only selection plus the 2px underline; measured after: widths 29px and 63px, the same as DSH's, underline 2px `rgb(122,170,255)` at `bottom: -1px`, hover `rgb(249,250,251)` |
| Status line | three **buttons** (`aria-haspopup="dialog"`) that open breakdowns: `N turns M steps · K tok/s`, `T tok · Cache hit X%`, `P% of context used` | the same facts as static text in `#composer-status` | **difference kept**: the numbers are the same; the dialog behind each is DSH's own detail view and would be a feature to build rather than a name to fix |
| Chat's turn strip | a `Turn navigation` nav of `Load and jump to turn N` buttons along the chat's right edge | none in Chat; the Trajectory view is where heddle reads a session step by step | **difference kept** |
| Row's leading content | `Running` / `Completed` in the muted body type, then the tagged name | an icon, and now **`Running`** for a session a turn is streaming into (from the same `model/request` / `turn/completed` pair the composer uses), then the name | **fixed for the live half**: `Running` is painted and removed as the stream says so; `Completed` is DSH's stored status, and a session's finished state is its `turns` count here rather than a word |
| Workspace row's controls | `Workspace actions for <name>` (the `…`) then `New session in <name>` | `…` only | **fixed**: the same pair in the same order, the second one hover-revealed like the session rows |
| Search field | a `Search sessions` button (`Alt+Meta+K`) that expands into a text field | a field that is always there, focused by the same chord | **difference kept**: one control instead of two, reached by the same key — a field that is visible costs nothing and the button only hides it |
| A clipped session title | while the pointer is on the row the title **crawls** to the far edge at **30px per second**, after an **8px** overflow floor, with a mask fade at each clipped edge; leaving returns it to the start in one step; reduced motion jumps to the end | only an ellipsis — a name wider than its row was never readable in full | **fixed this cycle**, measured from DSH's `useTitleMarquee` constants and verified with a trusted pointer: hover moves `scrollLeft` past zero and sets `data-scrolled`, leaving resets it, and a short title does not move |
| Pinned and archived rows | pinned rows show a **pin mark at rest** at the right where the hover pin lands and are absent of pin once archived; archiving a running session asks before stopping it | pin was only in the menu, an archived row still offered Pin, and archiving silently allowed a running turn | **fixed this cycle** (see SESSION_ACTIONS.md) |
| Cursor affordance | rows and **every control inside them** are `cursor: pointer`; a disabled control keeps the arrow | rows were pointer but the `…`, pin, archive, both header menus' triggers and Send were `default` — the difference the owner felt with a mouse | **fixed this round**, and asserted |
| Text selection | rows are `user-select: none` (they are draggable) | rows and their text are selectable | **difference kept**: copying a session's name out of the list is useful here, and nothing drags |
| Focus | the tree is not focusable, so focus lives on controls; ring by the platform | rows, menu triggers and tabs take focus and show the browser's 1px ring | match in effect; this UI is reachable by keyboard where DSH is click-only |
| Live state (a row still arriving) | a masked **shimmer sweep** over the row: `mask-image: linear-gradient(105deg, transparent 0, black 40%, black 60%, transparent 100%)` driven by a `shimmer-sweep` keyframe, at a slow rate | only a static caret (`▍`) | **fixed in cycle 3**: the same 105° masked sweep at 1.6s on a running assistant turn, the caret kept, and `prefers-reduced-motion` drops the sweep; measured `animation-name`, duration, mask and a settled row's `none`, then asserted |
| Scroll state | the session tree scrolls natively (`overflow-y: auto`, `padding-bottom: 16px`, no scroll shadow, not scrollable when short) | the same, plain native scrolling | match |
| Tree ARIA | `role="tree"` named "Sessions"; branch rows `aria-expanded`; session rows `aria-selected` and **no** `aria-expanded`; rows carry `draggable="true"` | `role="tree"`; branch rows `aria-expanded`; session and file rows `aria-selected` and no `aria-expanded` — **fixed this round**; rows are `tabindex="0"` | match on the state attributes, **difference kept** on `draggable` (drag-to-move is a feature) and on the label, which says "workspace folders" because this tree holds folders too |
| Tree keyboard | the tree and its items are **not focusable** (measured: no `tabindex`, `.focus()` does nothing, arrow keys do not move the selection); a session is chosen by a click or by the search field | each row is **one** Tab stop, its `.row` (the list item is not one, #92), and Enter/Space on it opens it; a key on a row's control is that control's (#98); no arrow keys in the tree, as in DSH | **difference kept on purpose**: this UI is reachable by keyboard where DSH is click-only, which is an addition rather than a mismatch |
| Row states | quiet tint, hover tint, selected = the same tint that stays | measured the same | match |

### The squashed session menu (2026-10-17)

**Report.** The session dropdown menu was squished.

**Research.** Measured **in its opened state** on a fresh server: the menu was 160x72 with four items of **20x16** each —
the width of an icon, with its label clipped away. DSH's own menu item, read from its sheet, is `width: 100%`,
`min-height: 34px`, `padding: 6px 8px`, `gap: 6px`, radius 12px, with a **16px** glyph; its container is `position: fixed`,
`min-width: 96px`, `padding: 4px`, `z-index: 70`.

**Understand.** A mechanism, not a value: the row-action rule `#tree .row-tools button` was a **descendant** selector, so
it also sized the buttons inside the menu that lives in the same slot. The closed menu looked fine because its items are
hidden.

**Plan.** Scope the action rule to the row's own buttons (`> .menu-wrap > button`, `> .session-actions > button`) and give
every menu item one shared rule with DSH's numbers. Rejected: patching each per-area menu rule — there are four, and the
descendant selector would have kept finding new victims.

**Verify.** After the change, measured in the opened state: items **152x34**, glyph **16x16**, menu 160x144, labels
unclipped. The inventory check now asserts, for every menu this page draws, each item's box, its label clipping and its
glyph box, so a squashed item cannot ship again. Part 7 is 40 checks and the unit suite 310, all green.

**Coverage.** Opened and measured: the session row's menu (the reported one), View options, the session header's More
actions. Not measured this cycle: the workspace row's menu and the attach menu — the shared rule covers them, but their
opened boxes were not asserted. The **model** menu is no longer in that list: it was measured item by item in
[`feat/model-selector`'s comparison](_context_/dsh-mechanisms/dsh-model-selector.md), which asserts its rows, options,
group headings and opened geometry.

**Lesson.** *A state that exists only after a click is part of the comparison*; a hidden surface is not a measured one.

### Verifier timings and the two targets (2026-10-17)

The owner asked which part of the suite is slow, and for browser checks to be optional. Measured from the runner's own TAP timings
(one full run, 45 checks, **134 s** summed):

| Check | Time | Needs |
|---|---|---|
| a folder opens and closes with the same control | 24.5 s | browser |
| the four session shortcuts act on the selected session | 11.3 s | browser |
| a written session moves to the top, its age follows, a pin click holds it | 10.1 s | browser |
| a session row's controls appear on hover, and a search replaces the tree | 9.5 s | browser |
| the panel follows the selection | 8.6 s | browser |
| a session is renamed from its own menu | 6.7 s | browser |
| View options groups the sessions two ways | 6.2 s | browser |
| New session here, on an instance row | 5.6 s | API/CLI |
| a clipped session title crawls on hover | 5.2 s | browser |
| the interactive inventory | 4.9 s | browser |
| a pinned row glides | 4.7 s | browser |
| the menu forks a session | 4.6 s | browser |

**The browser checks are the slow half**: 14 of 45 checks, and they account for almost all of the run. The split:

- `_tools_/verify-runner/browser.mjs`'s `browserAvailable()` answers **false** when `HEDDLE_VERIFY_UI=0`, so every browser check
  reports skipped with the reason "a browser on this machine";
- the runner gained `--allow-skip`: with it, a run with no failures and some deliberate skips is verdict `0` **and says so**
  ("all 31 judged check(s) passed; 14 skipped by this target"). Without the flag a skip is still exit `3`, so the contract that
  unjudged is not passing is unchanged — the standard target simply names what it did not judge.
- `npm run verify:fast` = unit suite + the standard target: **2 s + 47 s**. `npm run verify:ui` = every check: **149 s**.
  *(Those two numbers were measured on part 7 alone. Across **every** verifier part the targets are measured as: standard
  **234.5 s** and UI **593.3 s** on 2026-10-18 — the per-part table and the rule live in
  [`_conventions_/verify-targets/`](_conventions_/verify-targets/INDEX.md), because a cost rule belongs with the repository's
  conventions rather than only in this session's record.)*

### The tail in the middle of the head, at the reference's thickness (2026-10-17)

The owner asked twice more: the tail must sit **in the middle of the pin head**, and its thinness must match DSH — "not over thin, nor
over thick". Measured on the reference artwork: its needle is about **0.95 units** across at the body and narrows to a point, but its
axis runs **off the head's centre**, so copying its shape leaves the tail visibly to one side.

The head's lower edge runs from (10.72, 12.74) to (2.53, 7.01); its **midpoint is (6.625, 9.875)** and the outward normal points
down-left. The tail now starts exactly at that midpoint and is a **filled taper of 0.9 units at the base narrowing to 0.12** — the
reference's thinness with the reference's taper, but centred. Measured: the tail's base midpoint is **0.0 units** from the stated
middle, its base is 0.9 across (reference 0.95), its tip is 0.12 (a point), and it reaches 1.7 units below the head. The path states
where its base is (`data-tail-base`), so the check measures the drawn quad against the stated position instead of a guess; it asserts
the base is in the middle, the width band matches the reference, and the shape narrows to a point.

### A thin tail, centred on the head (2026-10-17)

The owner asked twice more: thinner, and **in the middle of the pin head**. Measured on the reference artwork: its filled needle leaves
the head about **1.8 units off** the head's centre line, and is about **0.95 units** thick — the asymmetry is in the reference itself.
So the head stays the reference's path exactly, and the tail is drawn as a **0.9-unit round-capped stroke** from the head's geometric
centre (the bounding-box centre of that path, 7.85, 7.22) outward along the same down-left direction. The head paints over the shaft's
first units, so the joint needs no seam.

Measured after the change: the shaft's line passes within **0.003 units** of the head's centre (dead centre), its stroke is **0.9**
against the head outline's 1, and its tip reaches **1.46 units** below the head. The check now judges the two shapes **by role** — the
filled head and the stroked tail — and asserts the tail is thinner than the head's outline and sits on its centre line, so neither
property can regress silently.

### A thinner pin tail (2026-10-17)

The tail was still thicker than the reference's. The shape was not the difference: the needle path **inherited the SVG root's
`stroke: currentColor`**, so it was painted at its own filled width plus a 1-unit outline — about twice as thick. The reference's
needle is **fill only**; the body is the part that carries a stroke. Setting `stroke: none` on the needle makes the tail thin
without changing its shape or its tip: the bbox stays 4.10 × 5.29 units and the tip still reaches below the body. The check now
asserts the needle reports `stroke: none` while the head keeps a stroke.

### The pin's tail: a malformed path (2026-10-17)

The solid pin showed its head but not its thin tail. The cause was in this page, not in the reference's artwork: the **needle
path's `d` had been compacted by hand**, and the compaction broke each cubic command into its own `C` with a single coordinate
pair — an invalid path that paints nothing. The body path happened to be all `L` commands, so only the tail vanished.

Found by rendering the two paths **in separate colours** at 240px: the body painted, the needle was blank. The `d` is now copied
verbatim from the reference (spaces included). Measured after the fix: the needle's box is 4.10 × 5.29 units and its bottom
(14.47) reaches below the body's (12.74), so the tail sticks out and the icon reads as a pin. The check now asserts both paths
paint and that the tail reaches below the body.

### The pin's ink and weight (2026-10-17)

Two nits from the owner, both measured before and after.

- **No accent blue.** The mark was drawn in the accent colour, which the owner does not want. It is now the neutral caption ink
  (`--text-3`), and the pin control that replaces it on hover keeps **the same ink and does not lighten on hover**. The glyph is
  therefore indistinguishable between the resting marker and the hovered control: the swap happens in place, and the icon stays
  exactly the same.
- **The weight made the pin unreadable.** The pin artwork was drawn with the tree glyphs' `stroke-width: 1.2`; on a *filled*
  body at 14px that outline is a bold blob, so the owner saw a head with a heavy line but no pin. The pin is drawn at the
  reference's **Regular** weight — `stroke-width: 1` — which also matches how DSH renders `IconPinOutlineRegular` /
  `IconPinFillRegular`. Measured after the change: the marker is `rgb(173, 178, 184)`, both artwork paths report a painted fill,
  the stroke is `1px`, and the hover control reports the same colour, weight and fill count.

### One pin mark, at the right, and a slower glide (2026-10-17)

Three follow-ups from the owner, and the layout reasoning behind them.

- **The mark lives at the right only.** The pinned mark had drifted beside the name, so a pinned row showed a pin on the left
  *and* a pin control on the right. It is now one 16px mark at the row's **right edge**, between the age and the controls, and
  the old beside-the-name badge is gone. The check asserts that nothing draws `.pin-mark` and that the mark's right edge is the
  row's content edge.
- **The two states swap in place, never overlap.** The right-hand side is **one right-aligned flow** — age, marker, controls —
  and the states swap their visible children by `display` (`age` + marker out, controls in), instead of stacking the controls
  over the age in one grid cell. The hover pin control therefore lands on the **same right edge** the marker occupied (asserted
  by edge equality), and only one pin icon is ever drawn. The swap also means the row must be **focusable** for a keyboard to
  reach its controls: every tree row now carries `tabIndex = 0`, without which `:focus-within` could never fire because the
  control it would focus is itself not rendered.
- **The glide is slower.** 400 ms instead of the reference's 200, at the owner's request (at 200 the row reached the top before
  the eye followed it, which read as a jump again). Easing, the entrance fade and the reduced-motion rule stay the
  reference's; the duration is a stated local choice.

### The pin artwork and the glide (2026-10-17)

**The icon is the reference's own.** DSH's primitives carry `IconPinOutlineArtwork` and `IconPinFillArtwork` (16px box, one
body plus a needle), and its rows swap them by state: **outline** for the action that would pin an unpinned session,
**solid** for a pinned one's marker and its unpin control. Both paths are copied here path for path; both fill the needle, and
the solid variant also fills the body — which is the difference the check reads.

**The move is DSH's `AnimatedRows`.** Read from its client bundle: a **FLIP** measured before and after a redraw and played
with the Web Animations API — a moved row animates from `translate(dx, dy)` to zero over **`ROW_GLIDE_MS = 200`** with
**`ease-out`**, a new row fades in over **`ROW_FADE_MS = 100`**, rows outside the viewport are skipped, and reduced motion
turns it off. This page keeps the numbers, the easing, the fade and the reduced-motion rule, and drops one part on purpose:
DSH arms its motion on the first pointer/key input because its rows re-render on a load, while this glide is entered only by
the pin handler — copying the guard made a programmatic pin move the row with no glide at all (measured), so the guard is
not copied. That decision is recorded in the code at the guard's old site.

### The pinned mark: the reference's artwork, in a reserved slot (2026-10-17)

The owner reported that pinning a row **moved the pin icon left**, and asked for a clear pinned/unpinned cue.

- **The mark is the reference's own artwork.** DSH's `IconPinOutlineArtwork` / `IconPinFillArtwork` (16px box) are copied path
  for path: the **outline** pin is the action that would pin, the **filled** pin is the state — for a pinned row's marker and
  for its unpin control, exactly as DSH swaps `IconPinOutlineRegular` / `IconPinFillRegular`. Both fill the needle; the filled
  variant also fills the body, and that is the difference the check reads.
- **The slot is always reserved.** The mark sits in a 16px slot at the row's right edge that every session row draws, empty when
  unpinned. Before this, the mark was appended only for pinned rows and pushed the age and the hover controls to the left, which
  is what made the pin control jump under the pointer. The check now asserts that the age and the controls keep their x position
  across a pin.
- **The cue is visible.** A pinned row's mark is the filled pin in the accent colour rather than DSH's muted caption tone: the
  owner asked for a visual cue, and the sidebar is where a pinned row needs to be recognisable at a glance. On hover the mark
  steps aside and the pin control itself carries the state (filled when pinned, outline when not).

### Row age, order and the blinking control (2026-10-17)

Three reports from the owner, one root each.

| Report | Root | Fix |
|---|---|---|
| A session being written to kept its old age (`1min`, `6d`) | the row aged by **`created`**, and nothing re-read the list while a turn ran | the store records **`updated`** on every message and turn boundary; the row ages by it and a 30 s ticker repaints the text; activity from any window re-reads the tree (debounced) |
| The pin "did not appear to work" | the mechanism worked, but the row's **age span intercepted the press**: the age shares the right-hand grid slot with the controls and painted above them | the age is **decoration** (`pointer-events: none`) and the controls carry `position: relative; z-index: 1`, so the icon that is seen is the icon that is pressed |
| Sessions were not ordered by what was done last | the comparator fell back to the **definition folder's clock name** | non-pinned sessions order by **`updated` descending**; pinned sessions still lead, and among pins the newest pin leads |

The second root is the same one as a fourth report — *the archive and pin icons blink while hovered*. A press dispatched at the icon's
centre was delivered to the age span while `elementFromPoint` named the icon; the two disagreeing is exactly a box that paints but
is not the one hit-testing reaches, and hovering puts the two in a loop. With the age out of the event layer the press reaches the
control, which the part-7 check now asserts by recording the mousedown target and refusing `SPAN.age`.

### The control chrome, measured from DSH's own sheet (2026-10-17)

The owner reported the row's icon buttons as a little too small and with a background unlike the reference. Both were
true, and both numbers had been sitting in DSH's stylesheets since the first audit:

| Class | DSH, from its sheet | This UI before | This UI now |
|---|---|---|---|
| **row action button** (`._actionButton`) | **20×16**, radius 4px, **no background**, hover changes the label colour only | 20×20 with a 12% hover patch, inside a row-tools slot that painted a `--sidebar` patch behind everything | 20×16, transparent, hover colour-only, no patch behind the slot |
| **icon button** (`._iconButton`, sidebar and panel actions) | **28×28**, 15px glyph, hover background | the size of its text (~24px), no hover surface | 28×28, `flex: none`, hover surface `--hover` |

The size miss had a second layer worth recording: a class rule setting 28px was being overridden by
`#workspaces-row > button { width: 24px }`, whose `id + element` specificity wins. The rendered box is the only honest
measurement; the rule you wrote is a hypothesis about it.

## The three reported defects (2026-10-17)

The owner reported three things after the cursor fix, and each had a different cause:

| Report | Measured cause | Fix |
|---|---|---|
| The `…` disappears when the session name is long | the controls were **absolutely placed over the row**, so the name's ellipsis still ran underneath them (label right 300, controls left 261 — an overlap); text showed between the icons | the age and the controls now share **one grid cell** in `.row-right`, whose width is the wider of the two: the name ellipsizes before the slot, and the slot is the same width whether the age or the controls are showing |
| The dropdown is transparent and its text overlays other content | it was **not transparent**: every menu measured `rgb(35,35,36)`. It was **clipped by the sidebar's `overflow`** — `View options` is wider than the space to the right of its trigger, and `position: absolute; right: 0` pushed its left half outside the sidebar, where it was cut. The visible half sat over the row text, which reads as transparency | menus are placed in **viewport coordinates** when they open (`position: fixed`, clamped to the viewport, flipped above the trigger when there is no room below), so no ancestor clips them |
| Menu items have no icons | every menu item measured `glyph: false` | each item carries a stroke glyph in the same 16px box the tree uses (`pin`, `rename`, `fork`, `archive`, `plus`, `download`, `unlist`, `clock`, `archive-restore`), drawn by `kindIcon` through a shared `menuMarks` set; `aria-hidden`, so the item's name stays the action |

**One regression was mine and it was worse than the three reports:** moving the age into the slot left a `const rowRight` declared *after* its first use — a TDZ error that threw for **every session row**, so branches rendered but their sessions vanished. It was found by capturing the page's `window.onerror` inside the probe, and the lesson is in the skill: a render that throws looks exactly like missing data.

### Cycle 2 of the three-defect goal — the inventory probe (2026-10-17)

**Research.** The three fixes were in place and the skill had just been rebuilt around a coverage matrix, so this cycle
ran the **DOM-derived inventory** it now prescribes as a check rather than as advice.

**Coverage.** Inventory of every visible interactive element (buttons, links, summaries, inputs, text areas, tabs,
treeitems, focusables) on the running UI for: cursor against its state, hit-test at the centre, clipping by any ancestor;
all three menus this page draws for `position`, opacity, viewport fit and a glyph per item; a long name against the row's
controls; and the page's uncaught errors. Not measured this cycle: the reference's own inventory for comparison (the
browser MCP is gone from this session, so DSH could not be driven; the reference numbers come from the earlier cycles).

**What the measurement found — two fix rows.**

1. **`Access mode` reported `cursor: default`.** It is a `<button>` with **no click handler**: an informational chip that
   looked like a control. DSH's access control opens a mode menu, which this UI has no mechanism for. Fixed by marking it
   `data-inert` in the page with the reason recorded — an inert chip keeps the arrow, an acting control is a hand — and
   the inventory skips it deliberately rather than by exception.
2. **The probe itself was wrong twice**: resize separators are `col-resize`, not pointers; and the controls the UI reveals
   on hover are `opacity: 0; pointer-events: none`, so a hit-test at their centre correctly misses them. The probe now
   knows both, which is the difference between an inventory that reports real defects and one that reports its own
   assumptions.

**Evidence.** After the fixes, the check passes: 40 part-7 checks, 309 unit tests, and the inventory reports no wrong
cursor, no covered control, no clipped control, all three menus `fixed`, on screen, opaque and glyph-complete, the long
name stopping before the controls, and no page errors. The invariant the structural change of cycle 1 could have broken —
rows still render, hover still reveals, selection still paints — is asserted by the same check and the ones around it.

**Verdict.** The three defects the owner reported have no fix row left, and the inventory that would catch their siblings
now runs on every verification of this part.

## The three-cycle loop

### Cycle 1 — the view ring and the user turn (2026-10-17)

**Research.** Measured DSH's `role=tablist` on its session view, element by element: the tablist is transparent with 8px of
left padding; each tab is plain text at **13px/500**, `padding: 0 0 9px`, no background, no border, no radius, and the
selected tab is told apart **by colour alone** — `rgb(122,170,255)` against `rgb(173,178,184)`. Measured this UI's ring
the same way: a 7% tinted box with a 5.6px top radius, a 1px border, 13.12px at weight 400, selection by tint.

**Understand.** A value and arrangement difference, not a missing mechanism: both sides have the same tablist, the same
roving tabindex and the same keys.

**Plan.** Re-draw the ring as DSH's plain tabs (rejected: keeping the tinted box — a segmented control is a different
control, and the tint plus border plus radius was three signals where DSH uses one). The screenshot that verified the ring
also seemed to show the user turn back in a right-hand bubble, which this record first called a second difference and a
reverted alignment. **That was wrong, and cycle 2 corrected it**: DSH's user message *is* a right-aligned bubble, and the
box measurement below settled it.

**Verify.** After the change, measured in the running UI: tabs transparent, `border-radius: 0`, `13px`, weight `500`,
padding `0 0 9px`, selected `rgb(122,170,255)` and unselected `rgb(173,178,184)`, widths 29px and 63px — DSH's own
widths. The user turn was pinned as `align-self: stretch` with a 12px radius on that wrong reading; cycle 2 replaced
the assertion with the measured bubble (`flex-end`, radius 20px, `rgb(44,44,46)`, width below the column's, flush with
its content edge). The ring's five properties per tab and the user turn's shape are asserted in part 7, and a screenshot
records the ring.

**Fix.** The first run of the new assertion failed because the two probes had been written inside the `cursors` object
instead of beside it — that was the check's shape, not the UI's, and it was corrected before the round closed.

**Not measured this cycle** (an explicit unknown list, per the comparison procedure): DSH's tablist `gap` between tabs
(the two tabs sit 36px apart at their measured positions, but the gap property itself was not read), the tab's line
height, and the hover colour of a tab. None of them is claimed.

### Cycle 2 — the ring's underline, the gap, and the two row heights (2026-10-17)

**Research.** Read DSH's **own stylesheet rules** (`cssRules`) instead of only its computed element values, and this
resolved the three unknowns cycle 1 had left: `.tab:hover, .tab[data-active=true] { color: label-primary }`, the
tablist's `gap: 36px`, tabs at 13px/500 on a 16px line, and — the part a computed-style pass on the element itself
cannot see — `.tab[data-active=true]::after` draws a **2px underline** in the accent colour, `bottom: -1px`, radius
`2px 2px 0 0`. A second rule pair gave two row heights: `.projectRow { height: 34px }` and `.sessionRow { height: 32px }`,
with `user-select: none` on both.

**Understand.** Values and arrangement, not a missing mechanism: this UI has the same tablist and the same rows.

**Plan.** Three measured values, one commit: the selected tab's 2px underline, the 36px gap, and 32px session rows (34px
workspace rows kept). Rejected: adding an underline only to the tablist's bottom border, which is a different element and
would run the full width rather than under the selected tab.

**Verify.** After the change, measured in the running UI: `#views` gap `36px`; the selected tab's `::after` `content: ""`,
`height: 2px`, `background: rgb(122,170,255)`, `bottom: -1px`, radius `2px 2px 0 0`; a session row 32px and a workspace
row 34px; tab widths 29px and 63px; and, with a **trusted pointer** on the unselected tab, its colour turned
`rgb(249,250,251)` — DSH's `label-primary` hover. All asserted in part 7; a screenshot records the underline.

**Fix.** Nothing failed after the change; the first assertion run was the check catching its own probe shape in cycle 1,
and that is why the lesson went into the skill: a probe is code and can be wrong about where it puts a value.

**Not measured this cycle:** the twin on the sidebar's scroller and DSH's own session row's inner `gap: 0` arrangement
(its children carry the spacing instead) — neither is claimed.


### Cycle 3 — the live state, the scroll state, and closing the loop (2026-10-17)

**Research.** Two state-matrix rows that earlier cycles had not walked. DSH's tree scroller: `overflow-y: auto`, a
16px bottom padding, no scroll shadow, and — measured at rest — not scrollable while the list is short. Its **live**
state, read from its stylesheets: a row that is still arriving carries a **masked shimmer sweep**
(`mask-image: linear-gradient(105deg, transparent 0, black 40%, black 60%, transparent 100%)` driven by a
`shimmer-sweep` keyframe), not only a blinking mark.

**Understand.** The scroll state is the same on both sides — nothing to do, recorded as a match. The live state is a
mechanism this UI lacked: it marks a running row with a caret and no movement.

**Plan.** Add DSH's masked sweep to a running assistant turn at the same 105° angle, keep the caret (it marks the answer
itself), and let `prefers-reduced-motion` keep the caret alone. Rejected: replacing the caret with the sweep, because the
caret says *where* the answer is still growing and the sweep only says *that* something is.

**Verify.** Measured with the same attribute the stream sets (`data-state="running"`): `animation-name:
heddle-shimmer-sweep`, duration `1.6s`, a non-`none` mask, and `none` on a settled row. Asserted in part 7. The first
two runs failed — **and the failures were the probe's, not the UI's**: `getComputedStyle` returns a **live**
`CSSStyleDeclaration`, and reading it after the attribute had been restored reported the settled state on a rule that
was working. The probe now snapshots the values before restoring, which is the lesson added to the skill.

**Fix.** Nothing further after the probe was corrected; the loop's closing measurement produced **no fix row** — every row
of the audit table is now *match* or *difference kept with a reason*, so the loop stops at cycle 3 as
[`_skills_/full-loop-goal`](_skills_/full-loop-goal/INDEX.md) says it should.

**Not measured this cycle:** the shimmer's rendering on a real streaming turn (a scripted turn finishes faster than a
screenshot can catch it; the state was measured through the attribute the runtime sets), and DSH's sweep timing (its
keyframes were read but no duration for the sweep was extracted).

## Presentation, measured

The feature half was matched first; this half was matched by **measuring both UIs in a browser** and by comparing
screenshots of the same view, rather than by eye. Every number below was read from `getComputedStyle` on
2026-10-17, on DSH's session view at 127.0.0.1:8080 and on Heddle's at 8082.

### The three row states

The owner's observation — "the `1min`/`1d` is at the right-most in DSH but not in Heddle, and hover and selected behave
differently" — was measured on both sides, and this is the whole of it:

| State | DSH, measured | Heddle, measured after the change |
|---|---|---|
| **quiet** | transparent; the age sits at the row's right edge (age ends 8px inside a row that ends at 268); the action buttons are in the DOM but measure **0 wide**, so they take no space | transparent; `ageRight` 278 of a row ending at 286 — the same 8px; `.row-tools` is `position: absolute` and `opacity: 0`, so it also takes no space |
| **hovered** | one `rgba(255,255,255,0.08)` tint; the age becomes **0 wide** and the three controls appear **in its slot** (`…`, archive, pin) | the same 8% tint; the age's `opacity` goes to **0** and `.row-tools` to **1**, both in the same right-hand slot |
| **selected** | the **same 8% tint**, name at weight **400**, **no left bar** and no shadow — selection is the tint that stays after the pointer leaves | the same 8% tint, weight **400**, `box-shadow: none`; the left accent bar and the bold name that this UI used for selection are gone |

Two rules follow from it, and both are now structural rather than incidental:

- **The right-hand slot is one slot.** The age and the controls are not two things side by side — the controls replace
  the age while the pointer or the keyboard is on the row, which is why DSH's age is the rightmost thing a reader sees
  and the controls never push it inward.
- **Hover and selection differ by persistence, not by strength.** DSH gives them the same surface; what tells them
  apart is that a selection's tint remains when the pointer leaves. A stronger tint plus a bar plus bold text was three
  signals for a state that needs one.

| Thing | DSH | Heddle before | Heddle now |
|---|---|---|---|
| Page surface | one dark ground `#151517`; the panes themselves measure **`border-radius: 0`** — only the composer card is rounded (28px) | flat columns, flush edges | inset 12px, **square panes**, the composer card alone at 28px (corrected in `18ec0e2`) |
| List row | **a workspace row 34px, a session row 32px** (two rules in DSH's own sheet), `border-radius: 12px`, `padding: 0 8px`, `gap: 6px`, 14px text | 26px tall, radius 4.8px, padding 2.6/4.8 | the two heights, measured: **34px for a workspace row, 32px for a session row** (fixed 2026-10-17, cycle 2) |
| Row age | 11px, muted `#adb2b8`, right-aligned | 11-12px mixed | 11px `--text-3` |
| Row controls | nothing until hover; then `…`, archive, pin | `…` always visible | all three hidden until hover **or keyboard focus** (`:focus-within`), always shown where hover is impossible |
| Reading text (the message body) | **14px on 24px**, `#f9fafb`, with `--dsh-content-font-size: 14px` on the paragraph itself | 15px on 24px | **14px on 22.75px** — the size matches; the leading is this checkout's 1.625 rhythm, 5% tighter than DSH's, and it belongs to the concurrent typography pass, so the audit records it rather than overruling it |
| Code | 12px on 19px, mono stack starting `SF Mono` | 13.2px | 12px family token, 19px leading |
| User turn | a **right-aligned bubble that hugs its text**: measured box 484px inside a 689px column, flush with the column's content edge, radius **20px**, surface `rgb(44,44,46)` | right-aligned bubble, radius 20px, `--chat-bubble` | **match** — an earlier row here said the opposite ("full width, left-aligned, 12px"), which was my error: I had read a screenshot instead of the element's box. The check now pins the measured bubble |
| Panel header | session name + chips above the tabs | *absent* — the name was only in the sidebar | `#session-head` with the name (15px/600) and its folder in muted 11px |
| Composer card | 28px radius, `#2c2c2e` | already matched | unchanged |
| Status line | 11-12px muted: turns, steps, tok/s, cache, context % | turns/steps/tok-s/context, 12px | unchanged (the features were already there) |
| Frame radius scale | xs 4 · sm 8 · md 12 · lg 16 · xl 20 · panel 28 | one `--radius: 8px` | `--radius-md: 12px`, `--radius-panel: 28px`, the rest as before |

What is deliberately **not** copied: the fixed dark palette (Heddle keeps its light/dark tokens and adopts DSH's
values as the dark half), DSH's right-hand tool sidebar and its subagent/background-job chips (Heddle has no such
mechanisms), and its turn toolbar with the colour-coded timeline band (Heddle's Trajectory view is the equivalent
projection and already exists).

## What Heddle does today

| Area | Heddle | DSH | Gap |
|---|---|---|---|
| Row content | title (or the clock folder name) + age, with the turn count on hover | state prefix + title + age | no state prefix; a session with no title still reads as an id |
| Row controls | one `…`, always visible | `…` + `Archive` + `Pin/Unpin`, revealed on hover | actions are all behind the menu; nothing appears on hover |
| Menu | `Pin session`, `Rename`, `Fork session`, `Archive session` (and the reversed labels when pinned or archived) | `Pin`, `Rename…`, `Archive`, no `Fork` | the same four names DSH uses, plus fork; shortcuts bound but not printed beside the items |
| Search | in-place filter of session rows; branches stay | separate flat results tree with the workspace on each row | ours loses the "where is it" answer; theirs loses the shape |
| View options | one `Show archived` / `Hide archived` item | grouping, ordering, three archive states | no grouping/ordering choice, binary archive |
| Panel | `Chat` + `Trajectory` (and `Docs` while a document is open) | `Chat` + `Trajectory` | close |
| Session facts | turns in the row, tokens not shown | turns, steps, tok/s, cache hit, context % | no usage footer |

## The plan

Ordered so that each phase is useful alone and testable alone. Every phase ends with a check in
`_verifiers_/70-workspaces-sessions/`, a live pass through the browser driver, and a commit.

1. **Fork a session — done 2026-10-17.** `POST /api/sessions/<id>/fork` copies the parent's **projected**
   messages into a new session, gives it the title `<title> (1)` with a rising ordinal, binds it to the same
   folder and writes a definition of its own; the row menu gained `Fork` and the view does not follow it.
   Verified in the browser: the menu reads `Pin · Rename… · Fork · Archive` and forking produced
   `… (1)` with age `now` above its parent. The definition's folder keeps the instance naming rule, so the
   identity is a clock name while the title carries the readable name.
2. **Hover affordances — done 2026-10-17.** A session row now carries `Pin`/`Unpin` and `Archive`/`Unarchive`
   beside its `…`, invisible until the row is hovered or holds focus (and always shown where hovering is
   impossible). A row that stands for no session draws nothing rather than dead buttons. Verified live: the
   hovered row computes `opacity: 1` with `["Pin session","Archive session"]` while its neighbours compute `0`.
3. **Search as its own result list — done 2026-10-17.** A query hides the tree and shows a flat result list;
   each hit reads `title · workspace · age`, and clearing (or Escape) restores the tree. The age is added to
   DSH's two fields because a store can hold many sessions with the same first message — measured: a search for
   `ready` returned 34 rows with one title between them. The earlier in-place filter is gone: it could not find
   a session whose branch was closed, and it never said where a hit lived.
4. **View options — done 2026-10-17, corrected 2026-10-17.** The sidebar header
   has a `View options` control, and **I first recorded the wrong thing about it**: from a snapshot I described it as
   holding DSH's three archive states and wrote that grouping and ordering were "deliberately not implemented". Opening
   DSH's menu on 2026-10-17 showed **four groups and eight items**: a `WorkSpace` heading, `Workspace Tree` / `In one
   list`, `Manual` / `Last updated`, and the archive trio. The claim was an assumption, and it is corrected here.

   What this UI now carries, in DSH's order: the `WorkSpace` heading (drawn as a section name, not an empty button), the
   grouping pair, `Last updated`, and the three archive states. `In one list` draws every session in one flat column —
   title, where it lives, its age, newest first and pinned first — with the rows chosen by the session they open; the
   hover controls stay on the tree's rows, where a session's definition folder is known, because a flat row that offered
   a rename it could not complete would be worse than a list that does not offer it. `Manual` is the one item still not
   built: drag-to-order plus a persisted order is a feature rather than a switch, and a group with a single item would
   be a control that cannot be chosen, so that group is left out of the menu and the difference is stated.

   Verified live on a fixture: `In one list` drew 50 flat session rows and no workspace rows, `Workspace Tree` brought
   the tree back, and the choice persisted. The archive tri-state is unchanged (`hide` / `show` / `only`), and
   `/api/tree?archived=…` is still how the tree is read. The same round found and fixed a **real bug**: `closeMenus`
   walked only `#tree`, so the two header menus never closed after an item was chosen and needed two clicks to reopen.
5. **The session's facts — already present.** The composer's status line (built by the other session working in
   this checkout) shows turns, steps, streaming tokens per second and the share of the context window, from the
   log and from the provider's own usage report — the same facts DSH puts under its composer. Nothing was added to
   it; what this round did was confirm it is the same set of readings and leave it alone rather than build a second
   footer beside it.
6. **Shortcuts — done 2026-10-17.** The four chords are DSH's own, read from its menu: `Alt+Meta+A` archive,
   `Shift+Meta+F` fork, `Alt+Meta+G` rename, `Alt+Meta+K` search. They act on the **row the panel is showing**, one
   listener on the document, a table of chords rather than four `if`s, and a chord that needs a session and has none
   says so instead of doing nothing silently. Verified by dispatching the four events in a browser and reading the
   effects: the search chord focuses the field, the rename chord renames the row, the fork chord adds `<name> (1)`,
   and the archive chord puts the selected row away with the same flag the menu writes.

### The step rows

Measured on 2026-10-17, DSH's per-step summary row and Heddle's `details.turn > summary`:

| Thing | DSH | Heddle |
|---|---|---|
| size | 14px | 14px for a tool row, 13px for reasoning |
| colour | muted `rgb(173,178,184)` = `#adb2b8` | `var(--chat-muted)` = `#adb2b8` — the same value |
| weight | 400 | 400 |
| row height | 33px with `padding: 0 0 8px` (25px of content) | `min-height: 24px` |
| hover | the icon swaps to a chevron | the icon swaps to a chevron (same idea) |

So the **styling** already matches, and nothing was changed for it. What differs is the **structure**: DSH groups
the steps of one turn under a collapsible header that reads `Completed in 6m 17s` and summarises the turn
(`Ran commands and updated the plan`); Heddle lists every step flat in Chat and gives the per-step projection to its
**Trajectory** view instead. Grouping the chat by turn is a second way to read one log, and this UI already has that
reading in a place built for it — so it is recorded as a deliberate difference rather than half-built, and the
suggestion to revisit it belongs with whoever asks for a per-turn chat, not with a styling pass.

### Two corrections this comparison needed

Both were mine, and both were found by measuring again rather than by arguing:

- **The panes are square.** DSH's `--dsw-radius-panel: 28px` token exists, and I applied it as a default — but DSH's
  panes themselves measure `border-radius: 0`, and only the composer card is rounded. The other session working in
  this checkout had already corrected that (`18ec0e2`), and the document now states the measured fact instead of the
  token.
- **The message body is 14/24, not 13/20.** My 13/20 reading came from a paragraph in DSH's **tool inspector**, which
  is a different surface with its own smaller type; the reading column's own paragraphs measure 14px on 24px with
  `--dsh-content-font-size: 14px` on the element. So the 14/24 that was in this UI all along was right, and my
  "correction" to it was measuring the wrong thing.

The lesson is the one this document is built on: a computed style belongs to the element it was read from, and a
number without its element is a rumour.

## Deliberate differences, kept

- **No delete.** An append-only log is the one thing a menu must not erase; archiving is reversible
  and is what the menu offers.
- **The tree keeps its shape.** A session is shown under the branch it worked in, `_sessions_`
  folders are not drawn, and a session is a leaf — DSH's list is flatter because it has no
  conventions tree underneath it.
- **No `agent team` or `subagents`** in the panel: Heddle has no such mechanism, and a control for a
  thing that does not exist is worse than no control.

## The rail, and the one decision that came from a report

The left panel collapses, which it did not before, and the arrangement is DSH's **measured** one rather than an
approximation. Read from its collapsed sidebar on 2026-10-17 with `getComputedStyle`, per element:

| Property | DSH | Heddle, before | Heddle, now |
|---|---|---|---|
| rail width | 56px | 56px | 56px |
| container padding | `18px 10px 6px` | `12px 4.8px` | `18px 10px 6px` |
| control box | 36×36 at x=10 | 26–32px at x=12/23 | 36×36 at x=10 |
| vertical pitch | 48px (36 + 12 gap) | 23px, then 7–8px gaps | 48px: y=18, 66, 114, 162 |
| icon | 18×18 | 16 and 15px mixed | 18×18 |
| radius | 12px | 8px | 12px |
| top control | the **brand mark**, 36×36, named `Open sidebar` | a generic panel glyph | the **Heddle icon**, 24×24 inside 36×36, named `Open sidebar` |

The owner's report that the tree had "stopped showing" was the **remembered** collapse: the state was written to
`localStorage`, so a reader who collapsed the panel once came back to a rail with no tree and nothing on screen to say
the tree had been put away rather than lost. DSH does **not** remember the state — its reload brings the wide panel
back — and that behaviour is now copied rather than improved on. The **width** is the preference and survives; the
collapse is a look at the content and does not. The browser check asserts the reload, not the storage key.

The owner's other observation was the panel's missing **primary action**. DSH's sidebar carries a `New session`
control between the brand row and the workspace list; Heddle had none — a conversation was started from a workspace
row's `…` menu, which is a gesture for someone who already knows the tree. Measured from DSH and now matching:

| Property | DSH | Heddle, now |
|---|---|---|
| box | 252×38 in its 280 panel (14px insets) | 328×39 in its 352 panel (12px insets) |
| radius | 12px | 12px (`--radius-md`) |
| border | 1px `rgba(255,255,255,.16)` | 1px `color-mix(text 16%)` |
| fill | `rgb(67,69,74)` | `color-mix(text 12%)` |
| text | 14px, weight 500 | 14px, weight 500 |
| padding | 8px 12px | 8px 12px |
| chord | `Alt+Meta+N` | `⌥⌘N` |
| rail form | second icon, 36×36 at (10, 66) | 36×36 at (10, 66), label and fill put away |

The action reuses `startSessionAt`, the same path a workspace row's `New session in …` takes, and the only new decision
is **which** workspace: the selected row's root, then the folder the prompt box was last aimed at, then the first
workspace the tree draws. With no workspace it says so instead of doing nothing.

The workspaces row's controls were also unstyled `<button>`s: the `+` painted as a platform chip (a grey fill and a
2-pixel border) beside a `…` that painted nothing. They are icon buttons with no chrome now, in both states.

## The empty state, which the panel did not have

DSH's home is a designed surface: a centred mark and heading above the composer. Heddle had an empty column under a
header that said `No session`, which reads as a panel that failed to load rather than one waiting for input. It now
shows an invitation painted from the panel's own state — the chat view with `current === null` — with the mark, the
heading `Start a conversation`, and the chord the primary action is bound to in a `<kbd>`.

Two states are judged every run: on a fresh panel (a workspace, no sessions) the invitation is shown and the
conversation's column is put away under it; after the primary action starts a session it gives way and the column is
back. Measured: the section takes the column's height (1048×611 in the 1400-wide window), the heading is 16.8px at
weight 600, and the hint is the muted `--text-3` at 14px.

The work also found a defect next to it: opening a session id that no longer exists left `current` pointing at nothing,
so the header said `No session`, the column was empty and the invitation stayed hidden. A failed read now releases the
pointer, restores the header, and paints the invitation — "there is nothing open here" is a state the panel should be
able to say.

## Read next

[`SESSION_TREE.md`](SESSION_TREE.md) for the tree's own rules — the boundaries, the badges, and
why a session is a leaf. [`SESSION_MODEL.md`](SESSION_MODEL.md) for what a session is and where its
log and definition live.
