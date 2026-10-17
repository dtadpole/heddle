---
title: Session UI, as DSH does it
version: 1.0.0
description: What DSH's session management looks like in use, what Heddle does today, and the plan to close the gap.
level: L2
status: draft
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
| Composer's controls | in one row: `+` / `Access mode, current: Full access` / `Select model, current <model>, reasoning effort High` / voice input / `Send message` | `+` / `Access mode, current: Workspace write` / `Select model, current <model>` / `Send message` | **fixed this round** for the two names (they now carry their value, as DSH's do); voice input has no mechanism here and is recorded as not built |
| View tabs | `role=tablist` with `role=tab` buttons, `aria-selected`, roving tabindex, arrow keys; **plain text** tabs — no background, border or radius, 13px/500, and the selected one told apart by colour alone (`rgb(122,170,255)` vs `rgb(173,178,184)`) | the pattern, but drawn as a bordered, tinted, rounded box | **fixed 2026-10-17**: transparent, no border, no radius, 13px/500, selected `rgb(122,170,255)`; measured after: 29px and 63px wide — the same two widths as DSH's, and the same colours |
| Status line | three **buttons** (`aria-haspopup="dialog"`) that open breakdowns: `N turns M steps · K tok/s`, `T tok · Cache hit X%`, `P% of context used` | the same facts as static text in `#composer-status` | **difference kept**: the numbers are the same; the dialog behind each is DSH's own detail view and would be a feature to build rather than a name to fix |
| Chat's turn strip | a `Turn navigation` nav of `Load and jump to turn N` buttons along the chat's right edge | none in Chat; the Trajectory view is where heddle reads a session step by step | **difference kept** |
| Row's leading content | `Running` / `Completed` in the muted body type, then the tagged name | an icon, and now **`Running`** for a session a turn is streaming into (from the same `model/request` / `turn/completed` pair the composer uses), then the name | **fixed for the live half**: `Running` is painted and removed as the stream says so; `Completed` is DSH's stored status, and a session's finished state is its `turns` count here rather than a word |
| Workspace row's controls | `Workspace actions for <name>` (the `…`) then `New session in <name>` | `…` only | **fixed**: the same pair in the same order, the second one hover-revealed like the session rows |
| Search field | a `Search sessions` button (`Alt+Meta+K`) that expands into a text field | a field that is always there, focused by the same chord | **difference kept**: one control instead of two, reached by the same key — a field that is visible costs nothing and the button only hides it |
| Cursor affordance | rows and **every control inside them** are `cursor: pointer`; a disabled control keeps the arrow | rows were pointer but the `…`, pin, archive, both header menus' triggers and Send were `default` — the difference the owner felt with a mouse | **fixed this round**, and asserted |
| Text selection | rows are `user-select: none` (they are draggable) | rows and their text are selectable | **difference kept**: copying a session's name out of the list is useful here, and nothing drags |
| Focus | the tree is not focusable, so focus lives on controls; ring by the platform | rows, menu triggers and tabs take focus and show the browser's 1px ring | match in effect; this UI is reachable by keyboard where DSH is click-only |
| Tree ARIA | `role="tree"` named "Sessions"; branch rows `aria-expanded`; session rows `aria-selected` and **no** `aria-expanded`; rows carry `draggable="true"` | `role="tree"`; branch rows `aria-expanded`; session and file rows `aria-selected` and no `aria-expanded` — **fixed this round**; rows are `tabindex="0"` | match on the state attributes, **difference kept** on `draggable` (drag-to-move is a feature) and on the label, which says "workspace folders" because this tree holds folders too |
| Tree keyboard | the tree and its items are **not focusable** (measured: no `tabindex`, `.focus()` does nothing, arrow keys do not move the selection); a session is chosen by a click or by the search field | rows are focusable and Enter/Space opens them | **difference kept on purpose**: this UI is reachable by keyboard where DSH is click-only, which is an addition rather than a mismatch |
| Row states | quiet tint, hover tint, selected = the same tint that stays | measured the same | match |

## The three-cycle loop

### Cycle 1 — the view ring and the user turn (2026-10-17)

**Research.** Measured DSH's `role=tablist` on its session view, element by element: the tablist is transparent with 8px of
left padding; each tab is plain text at **13px/500**, `padding: 0 0 9px`, no background, no border, no radius, and the
selected tab is told apart **by colour alone** — `rgb(122,170,255)` against `rgb(173,178,184)`. Measured this UI's ring
the same way: a 7% tinted box with a 5.6px top radius, a 1px border, 13.12px at weight 400, selection by tint.

**Understand.** A value and arrangement difference, not a missing mechanism: both sides have the same tablist, the same
roving tabindex and the same keys.

**Plan.** Re-draw the ring as DSH's plain tabs (rejected: keeping the tinted box — a segmented control is a different
control, and the tint plus border plus radius was three signals where DSH uses one). While checking the screenshot that
verified the ring, a **second** real difference surfaced: the user turn had gone back to a right-hand bubble, because a
later whole-file pass replaced the rule that had aligned it to DSH's full-width left-aligned block. Re-applied it and
pinned it.

**Verify.** After the change, measured in the running UI: tabs transparent, `border-radius: 0`, `13px`, weight `500`,
padding `0 0 9px`, selected `rgb(122,170,255)` and unselected `rgb(173,178,184)`, widths 29px and 63px — DSH's own
widths. User turn: `align-self: stretch`, radius 12px. Both pinned by assertions in part 7 (the ring's five properties
per tab, and the user turn's alignment and radius), and a screenshot records the ring.

**Fix.** The first run of the new assertion failed because the two probes had been written inside the `cursors` object
instead of beside it — that was the check's shape, not the UI's, and it was corrected before the round closed.

**Not measured this cycle** (an explicit unknown list, per the comparison procedure): DSH's tablist `gap` between tabs
(the two tabs sit 36px apart at their measured positions, but the gap property itself was not read), the tab's line
height, and the hover colour of a tab. None of them is claimed.

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
| List row | **34px** tall, `border-radius: 12px`, `padding: 0 8px`, `gap: 6px`, 14px text | 26px tall, radius 4.8px, padding 2.6/4.8 | 34px, radius 12px, `0 8px`, gap 6px |
| Row age | 11px, muted `#adb2b8`, right-aligned | 11-12px mixed | 11px `--text-3` |
| Row controls | nothing until hover; then `…`, archive, pin | `…` always visible | all three hidden until hover **or keyboard focus** (`:focus-within`), always shown where hover is impossible |
| Reading text (the message body) | **14px on 24px**, `#f9fafb`, with `--dsh-content-font-size: 14px` on the paragraph itself | 15px on 24px | **14px on 22.75px** — the size matches; the leading is this checkout's 1.625 rhythm, 5% tighter than DSH's, and it belongs to the concurrent typography pass, so the audit records it rather than overruling it |
| Code | 12px on 19px, mono stack starting `SF Mono` | 13.2px | 12px family token, 19px leading |
| User turn | **full width, left-aligned**, quiet surface, radius 12px | right-aligned bubble, radius 20px | stretched, left-aligned, radius 12px — and **pinned by a check**, because a later whole-file pass had silently put the bubble back |
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

## Read next

[`SESSION_TREE.md`](SESSION_TREE.md) for the tree's own rules — the boundaries, the badges, and
why a session is a leaf. [`SESSION_MODEL.md`](SESSION_MODEL.md) for what a session is and where its
log and definition live.
