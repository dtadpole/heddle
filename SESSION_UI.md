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

## What Heddle does today

| Area | Heddle | DSH | Gap |
|---|---|---|---|
| Row content | title (or the clock folder name) + age, with the turn count on hover | state prefix + title + age | no state prefix; a session with no title still reads as an id |
| Row controls | one `…`, always visible | `…` + `Archive` + `Pin/Unpin`, revealed on hover | actions are all behind the menu; nothing appears on hover |
| Menu | `Pin/Unpin`, `Rename…`, `Archive/Unarchive` | same plus **Fork**, with shortcuts | **no fork**, no shortcuts |
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
4. **View options.** A `View options` control holding: archive visibility (`Hide archived` /
   `Show archived` / `Archived only`), ordering (`Last updated` / `Manual`), and — if it earns its
   keep — grouping (`By workspace` / `One list`).
5. **The session's facts.** A footer for the open session: turns and steps, tokens, and the share of
   the context window used. Heddle's context service can answer the last one; the first two are in
   the log.
6. **Shortcuts**, once the actions exist: `Alt+Meta+A` archive, `Shift+Meta+F` fork, `Alt+Meta+G`
   rename, `Alt+Meta+K` search.

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
