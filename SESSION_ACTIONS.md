---
title: Session actions — pin, archive and fork
version: 1.1.0
description: What the reference implementation means by pinning, archiving and forking a session — read from the installed DSH packages — and how this project's backend and UI implement the same three, row by row.
grounded_in:
  - source: human-authored reading of the installed DSH packages on 2026-10-17
  - the owner's request to research, plan and implement the functions behind pin, archive and fork in both the backend and the UI
  - the comparison document SESSION_UI.md, whose row menu and hover controls these actions share
---

# Session actions

Three actions on a session, each with a meaning that is easy to get half right: **pin** changes where a session is
listed, **archive** takes it out of every listing while keeping it findable, **fork** creates a new conversation from
the state of an old one. This document records the reference's semantics first, then this project's implementation and
the differences that are deliberate.

The reference is the installed DSH, read at
`~/.volta/tools/image/packages/@deepseek-ai/dsh/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`.
File references below are to that tree.

## Pin

| Question | DSH | Where |
|---|---|---|
| What is stored | a registry-global **set of session ids**, not a per-session field | `dsh-workspace/lib/index.js`, `pinnedSessionIds` state |
| What order | a **prepend**: the most recently pinned id is first, and pinned sessions surface ahead of every unpinned one | `pinSession()` — `pinnedSessionIds: [sessionId, ...state.pinnedSessionIds]` |
| Does it touch the session | no — pinning never touches workspace accounting or the session's own record | the same function |
| Archived session | **refuses** (`WorkspaceArchivedSessionPinError`) | `pinSession()` |
| Idempotent | yes — an already pinned id resolves without writing | `pinSession()` |
| Row rest state | a pin indicator sits at the row's right (`_pinIndicator`, 16×20), where the hover pin button lands | `dsh-client-ui-workspace/lib/client.js` |
| Menu order | Pin is menu order 100, the hover button order 200 (rightmost on the row) | `session-actions/PinSession.d.ts` |
| Hidden when | on an **archived** row the pin menu item and button render `null` | the same file |

## Archive

| Question | DSH | Where |
|---|---|---|
| What is stored | a registry-global **archive set** of session ids; the session's workspace slot is untouched, so unarchiving restores its position | `dsh-workspace/lib/index.js`, `archivedSessionIds` |
| What it hides | the session from **every grouping surface** | the same state |
| Pin interaction | archiving **drops the pin** in the same durable write — the two are mutually exclusive | `archiveSession()` |
| Running work | **refuses** when the session reports activity (`workspace/session-activity` waterfall), unless `stopActivity: true`, in which case it writes the archive first and then asks `workspace/session-stop` providers to stop | `archiveSession(sessionId, { stopActivity })` |
| After archiving | an `agent/pre-step` gate rejects steps for an archived session, so a stop-induced wake cannot do work | `underArchivedSession()` |
| Unarchive | drops the id from the set; no existence check; the position returns | `unarchiveSession()` |
| UI confirmation | the client opens a dialog when the session has running work: confirming **stops the work and archives**, cancelling leaves it running and visible | `session-actions/ArchiveSession.d.ts` |
| Idempotent | yes — an already archived id resolves without writing, asking or stopping | `archiveSession()` |

## Fork

| Question | DSH | Where |
|---|---|---|
| What it copies | an **inclusive event prefix** of the source log — raw events, not projected messages | `buildForkSeed()` in `dsh-session/lib/index.js` |
| The cut | `atSeq`, or the **latest completed turn**: the last `turn/end`, extended over trailing events until the next turn start, appended user message or spliced inbox | `latestCompletedPrefixBoundary()` |
| No completed turn | **refuses** with `session/fork-unavailable` | `SessionController.fork()` |
| Open tail | the seed appends `session/end-seed { inherited: true }` and **synthetic closers** for an interrupted turn (a tool call started without a result gets a `forked` result telling the model the parent may have finished it after the fork point) | `buildForkSeed()` and the `forked` closers |
| Provenance | the child's header records `parentSession` and `isSeeded: true`; its workspace is the source's, so the child is listed **beside its source** | `SessionController.fork()` |
| Naming | the child gets a fresh `session-<uuid>` id and **no title**; the title arrives with its first prompt | the same function |
| Model | the child is created with the current default model selection, not necessarily the source's | the same function |
| Archived source | a fork of an archived session is an **independent** conversation — the archive gate follows lineage through subagent-origin sessions only | `underArchivedSession()` |
| UI | menu order 300; **no** hover button — fork is a menu action only | `session-actions/ForkSession.d.ts` |

## Cycle 1 — the rules, implemented and verified (2026-10-17)

Implemented from the gaps table above, backend and UI together:

- **Mutual exclusion.** `SessionStore.flags()` throws `SessionFlagError('archived')` when asked to pin an archived session,
  and **archiving deletes the pin and its time** in the same write. The route answers that refusal as **409 with
  `code: 'archived'`** rather than a 500 — the compiled module graph can hand the route a different class identity, so the
  catch recognises the class **or its name**.
- **Pin order.** A pin records `pinnedAt`; the tree orders pinned sessions by that time descending, so a pin is a stack
  (newest first) instead of a name sort, and an old pinned record without a time sorts after the timed ones.
- **Archive of a running session.** The route refuses with **409 `code: 'active'`** and the number of running turns unless
  the caller passes `stop: true`, in which case it aborts the turn through the same handle the Stop button uses and then
  archives. The page asks first — a native confirm naming what will happen to the work — and only then sends `stop: true`.
  (Superseded on 29 Oct by the refusal's `activity` list and DSH's own dialog; see *DSH parity, 29 Oct* below.)
- **Fork rules.** A fork is refused with **409 `code: 'unavailable'`** when the source has no completed turn, and the
  child records `parentSession` — the provenance DSH's header keeps. The title stays `<title> (n)` (kept difference, above).
- **UI.** Pin is absent from an archived row's menu and quick controls; an archived row carries `data-archived`; a pinned
  row shows a 14px pin mark at rest; archiving a running session asks before stopping it.

**Verified.** Unit: 320 passing, including the exclusivity, the pin time, the pin order (newest first, untimed after
timed), and provenance. Part 7: a new HTTP check runs pin → archive → refused pin → refused fork → fork with provenance
through the routes; the pin/archive check now asserts the pin is dropped and the 409; the inventory check reads a pinned
row's mark and an archived row's control set after switching the archive filter on. Every one of those checks passes
individually. **Not verified / open:** a full part-7 run hung once at the end of this cycle and was killed; the changed
checks were run individually instead, and hunting that hang is the next cycle's first task.

## Cycle 2 — fork naming, the cut, and the forkability rule (2026-10-17)

Read from DSH's session controller and implemented:

- **Naming.** `increasedForkTitle` increments an ordinal the title already ends with — `x (1)` becomes `x (2)`, a full-width
  `x（2）` becomes `x（3）`, and a title without one gains ` (1)`. `forkTitle` now does the same, so a fork of a fork is
  `x (2)` where it used to be `x (1) (1)`; a name already taken still steps past itself, because this store lists titles.
- **The cut.** `completedPrefix` returns the log up to its last completed turn, and `fork` copies the projection of that
  prefix — a question recorded after the last answer is not carried into the child.
- **Forkability.** The guard asks the **projection of the inherited prefix** rather than the event vocabulary: a session is
  forkable when that projection holds an assistant message, or the log records `assistant/completed`. This fixed a measured
  refusal: a fork's own log holds copied **messages** and no assistant chunks, so a fork of a fork answered `409` before the
  guard learned the difference, and a recorded question with no answer is still refused.
- **What the UI does after a fork.** DSH's client passes `increaseTitle: true` and does **not** navigate to the child; it only
  reports creation. This UI re-reads the tree and keeps the current selection — the same behaviour, asserted rather than
  assumed.

**Verified.** Unit: the naming cases (ASCII, full-width, taken), the cut (dangling tail drops, two turns keep both, no
completion returns whole), and the forkability rule (dangling question refused, completed answer allowed, a forked
conversation allowed). Part 7: the fork check now forges a fork of a fork and asserts `x (2)` and `parentSession`; a new
browser check opens a row's menu, takes **Fork session**, and asserts the child row appears named after the source.

## Cycle 3 — the full measurement (2026-10-17)

The cycle that the goal's stop rule asks for: all three actions measured together, with no fix row left.

- **Suites.** Unit 326 passing; part 7 **43 of 43** checks passing (`verdict 0`), run through the standard verifier.
- **What the measurement changed.** One check's own fixture grew enough rows to scroll the tree, and the inventory's clipping
  test called the last row clipped; the rule now exempts a **scroll container**, because content below a scrollbar is
  reachable rather than cut away. The archive chord's confirmation (added in cycle 1) is a native dialog, and a headless
  browser dismisses it; the chord check stubs it and the confirmation is judged where it lives.
- **The hang from cycle 1.** A full part-7 run hung once; a rerun with `--test-timeout` passed all 42 in 125 seconds, and the
  standard verifier then answered `verdict 0` repeatedly. Treated as a transient (a browser or process contending during the
  run), not a defect in a check: no assertion changed because of it, and every later full run completed.
- **Coverage.** Measured: pin order and its mark, pin refusal on an archived row, archive dropping the pin, archive of a
  running turn (refused without `stop`, accepted with it), unarchive, fork naming in place, the cut, forkability, provenance,
  the tree placement and the menu path to fork. Not measured, and named: the archive confirmation dialog's own look (only its
  accept path is exercised), and concurrent forks of one source.

## Cycle 6 — the row's remaining marks, and a verifier that does not need a browser (2026-10-17)

Five nits, each measured.

- **One pin, on the right.** A leftover badge from an earlier pass still appended an outline pin **beside the name**, so a pinned row
  showed two pins. The badge and its CSS were removed; the check asserts no `.pin` exists and exactly one mark sits in the right-hand slot.
- **Running is a spinner, not a word.** Read from the reference's `StateDot.module.css`: ongoing is two 2px rings in a 24-unit box,
  a track at 25% opacity and an arc whose dash breathes (12→24→12, 1.5 s ease-in-out) while the whole group rotates 360° in the same
  1.5 s linear, reduced motion showing a still arc, and all spinners pinned to one start time. The tree row paints that mark before
  its name and removes it at `turn/completed`. The check asserts the state, the two rings, both animations and their timing, the
  track opacity, and removal.
- **The session glyph is the reference's bubble.** Its `NewChatOutlineArtwork` is a speech bubble with a plus; the plus is the action,
  the bubble is the conversation, so the row uses the bubble alone — one path, distinct from the folder marks. The check asserts the
  path and that it differs from a folder's.
- **Verifier timings, and two targets.** The slowest checks were attributed from the runner's TAP durations (the full table is in
  SESSION_UI.md): the browser checks are 14 of 45 and take almost the whole run. `browserAvailable()` now honours
  `HEDDLE_VERIFY_UI=0`, and the runner gained `--allow-skip`, which makes a no-failure run with deliberate skips verdict 0 **and says
  what it skipped**; without the flag a skip is still exit 3. Targets: `npm run verify:fast` (unit + standard checks, **49 s**) and
  `npm run verify:ui` (everything, **149 s**).

## Cycle 5 — the pin icon and the glide (2026-10-17)

- **Research.** DSH's icon primitives were read for the pin: `IconPinOutlineArtwork` / `IconPinFillArtwork` (16px box, a body
  and a needle), used as **outline for the pin action** and **solid for the pinned state**. Its `AnimatedRows` reads row
  positions before a commit and animates the FLIP after it: `ROW_GLIDE_MS = 200` with `ease-out` for a moved row,
  `ROW_FADE_MS = 100` for a new one, reduced motion off, first-input arming, viewport-only.
- **The mark.** The pinned row's rest-state marker is a **reserved 16px slot at the row's right edge on every row** — empty
  when unpinned — so pinning moves nothing, which was the report ("the icon moved to the left"). The marker and the unpin
  control use the **solid** artwork in the accent colour; an unpinned control uses the **outline**.
- **The glide.** Pin/unpin captures the rows, redraws, and animates each moved row from its old offset to zero (200 ms,
  `ease-out`), new rows fade in (100 ms). Reduced motion skips it. The reference's first-input arming guard is **not** copied,
  with the reason in the code: this glide is entered only by the pin handler, and the guard made a programmatic pin move
  without gliding (measured).
- **Verified.** Part 7's new check pins a row and, in the same page turn, reads the animation (`duration 200`,
  `easing ease-out`, `translate(0, dy) → translate(0, 0)`), its clock advancing while it runs, the resting transform `none`,
  the final order with the row first, the solid glyph on its control, and — under emulated `prefers-reduced-motion: reduce` —
  zero transform animations while the order still changes. Unit 383 and part 7 45 of 45, verdict 0.

## Cycle 4 — age, order and the pressed control (2026-10-17)

The owner reported three behaviours; each was reproduced before it was changed, and each now has an assertion.

- **Age.** Rows read `created`, so a continuing conversation kept the age it was born with. The store now writes `updated` on
  every message and on each turn boundary (`message()`, `turn/completed`, `assistant/completed`, `context/note`), the tree
  exposes it as `session.updated`, the row ages by it, and a 30 s ticker moves the text while nothing happens. Activity in
  any window re-reads the list (debounced 400 ms), so a message sent from the CLI or another tab moves the row.
- **Order.** The comparator's last resort was the definition folder's clock name. Non-pinned sessions now order by
  `updated` descending, pinned first (newest pin first among them) — the reference's list order.
- **Pin.** Reproduced with a trusted pointer: the handler and the store were right, but the press at the icon's centre was
  delivered to the row's **age span**, which shares the right-hand slot and painted above the controls. The age is now
  `pointer-events: none`, the controls carry `position: relative; z-index: 1`, and the blinking icon reported in the same
  breath is the same defect seen as paint/hit-test disagreement.

**Verified.** Unit: the store's `updated` (a message and a turn boundary both move it) and the tree's order (newest write
first; still pinned-first). Part 7: one browser check drives the whole cycle with trusted input — rows are ordered by write
time, a `POST /api/turn` to the older session moves it to the top with its age reading its `updated`, and a trusted click on
the row's **hover pin control** (the press target asserted to be the control, not `SPAN.age`) holds it at the top with the
store recording exactly one pin. Unit 334 and part 7 green after the change.

## This project's implementation, before cycle 1

| Action | Backend | UI |
|---|---|---|
| pin | `POST /api/sessions/<id>/flags {pinned}` → `SessionStore.flags()` writes `pinned: true` into the session's **meta file** | menu `Pin session` / `Unpin session`; quick control on the row |
| archive | the same route with `{archived}` → `archived: true` in the meta file; the tree hides archived sessions unless `?archived=show|only` | menu `Archive session` / `Unarchive session`; quick control; View options filter |
| fork | `POST /api/sessions/<id>/fork` → `SessionStore.fork()` copies the **projected messages** (minus system) into a new session; `SessionService.fork()` titles it `<title> (N)` and writes its definition | menu `Fork session` only |

## Gaps against the reference, and what this project will do

| Gap | Decision |
|---|---|
| pinning and archiving are not mutually exclusive here | **fix**: pinning an archived session is refused; archiving drops the pin |
| pin order is "pinned first, then newest name" | **fix**: record a `pinnedAt` time and order pinned sessions **most recently pinned first** |
| archiving while a turn runs is allowed silently | **fix**: the route refuses with a structured error naming the activity, and the UI asks before stopping and archiving |
| a fork has no provenance | **fix**: record `parentSession` on the child's meta |
| a fork with no completed turn is allowed and copies nothing | **fix**: refuse with `fork-unavailable` |
| the fork copies the projected messages, not the raw event prefix | **kept**: replaying another log's shadowing ranges into a fresh log means remapping sequence numbers, and a wrong remap is worse than a clean projection. The visible conversation is what a reader forked; the log stays the source of truth |
| our fork is titled `<title> (n)` | **kept**: this UI lists sessions by title, and two rows called the same thing cannot be told apart; the reference relies on the first prompt to name its child |
| DSH's pin indicator in the row's rest state | **fix**: a pin mark on a pinned row, at the right where the hover button lands |
| Pin hidden on archived rows | **fix**: no pin control on an archived row |

## DSH parity, 29 Oct — the work named, the dialog, unarchive from search (R-developer-eight-13, -14)

- **The refusal names the work.** `409 code: 'active'` now carries DSH's `activity` (`dsh-workspace` `archiveSession`,
  `workspace/session-active`): `{kind: 'turn'}` for the session's own running turn and `{kind: 'subagent', items}` for its
  running subagent descendants, found by lineage (`src/session/activity.ts`, `heddle_session::session_activity`). A session
  whose own turn has ended but whose subagent still works is refused too; `stop: true` stops the turn and each listed child
  (the Web server's handles and the live-turn registry). DSH's two other families — background jobs and scheduled
  reminders — have no runtime here yet, so nothing reports them; the page words them if a server ever does.
- **The dialog.** The page sends the plain archive first and opens the stop-and-archive dialog only when the server
  refuses: DSH's title, its description naming the session and the restore path, the work one family per line, Cancel and
  Stop and archive. A quiet archive asks nothing and, like a stop-and-archive, shows DSH's notice with `undo` (and
  `filter archived sessions` while archived rows are hidden); undo does not resume stopped work.
- **Unarchive from search.** An archived search result carries `Unarchive session`; choosing the result says "Archived
  sessions cannot be opened. Unarchive it to view." and keeps the query.
- **The row menu reachable.** An archived row's dimming moved from the item to its words (the item's opacity made it a
  stacking context), and an open menu's slot rises to the menus' layer, so no part of the menu lies under the conversation
  panel. Not changed: opening an archived row from the tree, which DSH also refuses (C16's ground), and a stopped
  subagent's settlement notice, which can still start a turn on the archived parent where DSH's pre-step gate blocks it.
