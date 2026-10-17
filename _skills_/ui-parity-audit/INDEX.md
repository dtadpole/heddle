---
title: UI parity audit
version: 1.0.0
description: How to compare this UI against the running DSH element by element — the instruments to drive, the checklist that has caught real differences, and the lessons paid for by the misses.
grounded_in:
  - owner statement 2026-10-17 that a cursor that does not become a hand is exactly the kind of difference a thorough check must not miss, and that the checking procedure must be recorded so it is not missed again
  - the audit of 2026-10-17 that produced SESSION_UI.md, in which eleven dimensions were found to differ and five real defects were fixed
  - the reflection browser-modes convention, which says how the browser is driven
---

# UI parity audit

**Use this when** any of these is true:

- a UI surface is meant to match a reference implementation (for this project: the running DSH at
  `http://127.0.0.1:8080/`, and this UI at the daemon's URL);
- the owner reports a difference in feel ("the cursor is not a hand", "hover and selected behave differently",
  "the age is not right-most");
- a session is about to claim that a surface "matches" — it does not match until this has been walked.

## The instruments

| Instrument | For |
|---|---|
| the browser MCP (`mcp__browser__*`) | driving both UIs: `evaluate_script` for computed styles, `hover` for real pointer states, `press_key` for chords, `take_screenshot` for a visual record |
| `getComputedStyle` on **both** sides | the only honest source of a number: a screenshot is a picture of a value, a computed style *is* the value |
| the same measurement script on both pages | one function, run twice, so the two columns are read the same way |
| the running UI, not a fixture alone | fixtures prove a flow; the owner's UI proves the feel |
| a new assertion in `_verifiers_/70-workspaces-sessions` | the difference cannot come back unnoticed once a check names it |

## The procedure

1. **Inventory.** List the surfaces a person touches: the tree rows, their hover controls, the menus and their
   items, the header, the tabs, the composer, the search, the status line, empty and loading states.
2. **Measure both sides.** One script, run on each page, recording the same properties for the same elements.
   Never compare a measurement of one side against a memory of the other.
3. **Write the diff down** in a table with three possible verdicts per row: *match*, *fixed this round*,
   *difference kept* — and a kept difference needs its **reason** and, when it belongs to someone else's
   work, its **owner**.
4. **Fix one thing at a time**, verify it with the same measurement plus a screenshot, and put an assertion in
   the checks so the fix is pinned.
5. **Loop**: re-run step 2 afterwards, because a fix to a token or a shared rule can move something else.

## The checklist — every dimension that has ever differed

### Geometry
- Row height, border radius, horizontal padding, gap; the panel's radius and inset; the composer card's radius.
- Hit-area size of a control (DSH's row buttons are 16px wide in 26px steps).

### Typography
- Font family stack (including the CJK fallbacks), size, line height, weight — and **for which element**: the
  reading column's message body is 14/24 in DSH, while a tool-description block in its inspector is 13/20.
  Measure the element you mean.
- Code: 12/19 mono; inline chips are smaller than prose.

### Colour and surfaces
- The reference's measured values, not its design tokens: DSH's `--dsw-radius-panel` is 28px but its **panes**
  measure `border-radius: 0`; only the composer card is rounded. A token is a claim, a computed style is a fact.

### Cursor and pointer affordance (missed until 2026-10-17)
- `cursor` on a row **and on every control inside it**. A row can be a hand while the `…`, pin, archive, the
  header menus' triggers and Send stay the platform arrow — that is exactly the difference the owner felt.
- A disabled control keeps the arrow: a hand there promises what the control refuses.
- `user-select`: DSH's rows are `none` (they are draggable); a reading UI may keep text selectable, but say so.

### The three states, and focus
- Quiet / hovered / selected, each measured separately: background, text colour, weight, any bar or shadow.
- Selection may differ from hover by **persistence**, not by strength — DSH's are the same 8% surface.
- And `:focus-visible` must be visible; the browser default ring counts only if it is not removed.

### Order
- Controls inside a row (DSH: `…` first, then the row's actions), menu item order, tab order.
- Order is part of the feel: the same three gestures in another sequence is a translation the reader performs.

### Names
- `aria-label` / visible text of menu items, **verbatim** from the reference: `Pin session`, `Rename`,
  `Fork session`, `Archive session`; `More actions`; `Workspace Tree` / `In one list`.
- A control that shows a value names the value: `Access mode, current: Full access`, `Select model, current …`.

### Semantics and ARIA
- `role=tree` / `treeitem`; `aria-expanded` on branches only; `aria-selected` on chosen leaves; `role=tablist`
  with `role=tab` and a roving tabindex; `aria-haspopup` on menu triggers.
- A **check** can read these: `aria-selected` on the tree item, not `aria-current` on the row.

### Keyboard
- Reachability (are rows focusable?), the reference's chords, Escape to close menus, arrow keys in a tablist.
- Measure the reference's own reachability before copying a pattern: DSH's tree is **not focusable** at all.

### Periphery
- Status line: are its facts text or controls that open detail?
- Search: an always-visible field, or a button that expands?
- Empty, loading, disabled and error states.
- Menus: do they close when an item is chosen and when the pointer leaves? (A header menu that stays open
  makes its trigger need two clicks.)

## Lessons already paid for

| Miss | What it cost | The rule now |
|---|---|---|
| Every control in a row had `cursor: default` | the owner felt it before any check did | the cursor checklist above; assert it in the checks |
| Selection marked with `aria-current` on the row | the tree's chosen state was not what a screen reader expects | `aria-selected` on the `treeitem`, stylesheet reads it |
| `aria-expanded="false"` on session leaves | told a screen reader a leaf has children | branches only |
| The row's controls drawn before the `…` | the same gestures as DSH in a different order | `…` first, measured from DSH's own DOM |
| The age pushed inward by the controls | DSH's rightmost thing was not this UI's | one right-hand slot; the age and the controls share it |
| `closeMenus` walked only `#tree` | the header menus needed two clicks to reopen | close every `.menu-wrap` |
| A group heading drawn as an empty button | a control that does nothing appeared in a menu | headings are labels, tested by the field being present |
| "View options has three items", from a snapshot | the document claimed grouping and ordering were deliberately absent, when DSH has all three groups | open the menu; a snapshot is a guess with a picture |
| 13/20 taken as the reading size | it was a paragraph in DSH's tool inspector, not the reading column | measure the element you mean |
| `--dsw-radius-panel` applied to the panes | DSH's panes measure 0; the token is only for the composer | measure, do not infer from tokens |
| A backtick inside a page-script template literal, five times | a syntax error and a debugging round each time | the check file's header states it; none of those comments use backticks |
| The view ring was a bordered, tinted, rounded box | DSH's tabs are plain text with colour-only selection — the box made one control read as a segmented control | a control's **shape** is part of parity, not just its colour; measured `background`/`border`/`radius`/`padding` as properties |
| A whole-file pass replaced an already-aligned user turn and a fixed header | the fixes silently reverted, and only a screenshot caught it | an alignment fix ships with an assertion; a shared file can be replaced wholesale by concurrent work, and the check is what survives it |

## The report

A round of this audit ends with: the diff table updated in `SESSION_UI.md`, the fixes committed with the
measurements in the message, an assertion per fix in the checks, the suites green, and — if the owner asked
for a loop — the goal left active until the last cycle has verified.
