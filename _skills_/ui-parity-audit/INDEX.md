---
title: UI parity audit
version: 2.2.0
description: How to compare this UI against a running reference so that nothing is missed twice — a coverage matrix, a DOM-derived inventory instead of a remembered list, adversarial content, occlusion checks, and the ledger of every miss already paid for.
grounded_in:
  - owner statement 2026-10-17 that a cursor which does not become a hand, a hidden ellipsis under a long name, a clipped menu and icon-less menu items are exactly the misses a thorough comparison must prevent, and that the procedure itself has to be improved rather than each miss fixed alone
  - the audits of 2026-10-17, in which thirteen differences were missed at least once before being found
  - the catalog skill ui-comparison, whose state matrix this skill extends with coverage, occlusion and content stress
  - the reflection browser-modes convention, which says how the browser is driven
---

# UI parity audit

## Why this skill exists, and the one mistake behind every miss

Every miss in the audits of 2026-10-17 had the same shape: **I compared what I remembered to look at, not what the
target actually contains.** A remembered list has four holes, and each shows up as a different kind of miss:

| Hole | The miss it produced |
|---|---|
| the list names *surfaces* but not *every interactive element inside them* | the row's cursor became a hand while the `…`, pin, archive and Send stayed the platform arrow |
| the list names *properties* but not *the content that stresses them* | a long session name ran under the controls; every measurement had used a short name |
| the list measures *the element* but not *the space around it*: clipping, stacking, hit-testing | a menu was reported "transparent" when it was opaque and **clipped** by the scrolling sidebar it sat inside |
| the list names *labels* but not *the anatomy of the thing carrying them* | menu items were compared by their words and were missing their icons |

So the improvement is not a longer remembered list. It is to **derive the comparison from the DOM and from adversarial
content**, and to keep a matrix whose empty cells must be filled or declared.

## The coverage matrix

A comparison is a set of **surfaces** crossed with a set of **dimensions**. Every cell must end as *match*, *fixed*, or
*not measured — and why*. A cell that was never visited is a future miss, and an unvisited cell that is not declared is
the miss this skill exists to prevent.

| Dimension | What it asks, per surface |
|---|---|
| **inventory** | every interactive element, found by the DOM (roles, buttons, links, `tabindex`), not by memory |
| geometry | box, height, width, radius, padding, gap, alignment, reserved space |
| typography | family, size, line height, weight — **for the element you mean** |
| colour and surface | background, text, border, shadow — measured, not read from tokens |
| **anatomy** | what the thing is made of: icon, label, shortcut, badge, state mark, count |
| states | idle, hover, hover-left, focus, selected, disabled, live |
| **opened surfaces** | everything a click brings into existence: the menu, its items, a dialog, a popover. Measure it **while open**, item by item |
| **content stress** | long, empty, unicode, many items, deep nesting, zero rows |
| **occlusion** | is it fully visible? clipped by an ancestor? under another layer? hit-testable at its centre? |
| **control chrome** | the box of a **control**: its size and hit area, its padding and radius, its background and its hover surface, and the size of the glyph inside it. The reference usually has **more than one class** — a small row-action button and a larger icon button — and each must be matched by its own class |
| cursor | is every clickable thing a hand, and does a disabled one keep the arrow |
| order | controls in a row, items in a menu, a tab order |
| names | visible text and accessible name, **verbatim** from the reference |
| semantics | roles, `aria-*` state, labels, live regions |
| keyboard | reachability, chords, Escape, arrow keys, focus ring |
| periphery | menus close, search expands, status is text or controls, empty and loading states |

## The procedure

### 0. Pin the artifact before judging anything

- Build, **reload**, then check a marker in the served script (a function name this round added). A tab loaded before
  the build keeps the old script in memory; this checkout's concurrent sessions also rebuild `dist` under a running
  check, which has produced false reds and false greens in one session.
- Record the URL and build next to every number.

### 1. Derive the interactive inventory from the DOM

Run the probe at the end of this file on the reference and on this UI. It lists every element a person can point at,
with its role, its cursor, its accessible name, its box, and **whether a hit-test at its centre returns it**. That is
how "the row is a hand but the controls inside it are arrows" gets caught by construction instead of by luck.

### 2. Write the anatomy of each surface

Before measuring, say what the thing is made of. A list row: kind mark, state word, badge, label, age, hover controls.
A menu: trigger, surface, sections, items, and each item's icon, label, shortcut and current-state mark. A tab ring:
tablist, tabs, selection mark, focus ring. Naming the parts is what makes an icon-less item or a missing age visible.

### 2b. Match each control to its **class**, and measure the rendered box

A control's size is not one number: the reference has a **row action button** and an **icon button**, and a UI that
matches one class and uses its numbers for the other is wrong on both. Measure, for every control class:

- the **rendered box** (`getBoundingClientRect`), never the `width` you wrote in a rule — a later rule with a higher
  specificity can override it, and a selector that does not match renders at whatever else applies;
- its **background** in idle and hover (the reference may have none, with hover changing only the text colour);
- the **glyph** size inside it;
- the row's own hover surface separately, because the control sits on it.

Measured on 2026-10-17 from DSH's own sheet: its row action button is **20×16, radius 4px, no background, hover changes
the colour only**; its icon button is **28×28 with a 15px glyph and a hover surface**. Both numbers were in its CSS the
whole time; this UI shipped a 24px icon button and a 20×20 action button with a hover patch because nobody compared the
rendered boxes to the reference's two classes.

### 3. Measure per element, per property — with integrity rules

- Read the **element a person reads**, not a neighbour: the reading column's paragraph is 14/24, an inspector's
  description is 13/20. Say which element produced the number.
- **Pseudo-elements count**: `getComputedStyle(el, '::after')` — the selected tab's underline lived there and a whole
  cycle missed it.
- A `CSSStyleDeclaration` is **live**: snapshot values **before** restoring a state, or every property reports the
  restored state.
- One probe is a hypothesis: re-measure before concluding, and compare a number against the reference's number for
  the **same element**, never against a token that merely looks equivalent.

### 4. Stress the content, not the sample

Measure with the content that breaks layouts: a name longer than the row, an empty title, unicode and emoji, a menu
with many items, a list with zero rows, a deep tree. Then assert **reserved space**: the label must ellipsize *before*
the controls, not underneath them (and a hit-test at the control's centre must land on the control, not the label).

### 5. Check occlusion, clipping and stacking

An element can be opaque and still unreadable. For every floating surface (menu, dialog, popover) and every control
near an edge:

- compute its box against **every scrollable or clipping ancestor** — `position: absolute` inside a scroll container is
  clipped by it, which is what "the menu is transparent" turned out to be;
- ask `document.elementFromPoint(centre)` whether the point delivers the element you think it does;
- check `z-index` and stacking contexts when two panels meet (the sidebar and the conversation).

A menu belongs in **viewport coordinates** (`position: fixed`, clamped, flipped when short of room), not inside the
scroll container that will cut it.

### 5b. Measure what a click brings into existence

A closed menu is a hidden element; the defect lives in its **opened** state. For every surface a click creates:

- open it with **trusted input**, then measure the container's box, `position`, `z-index`, background, and whether it is
  inside the viewport and outside every clipping ancestor;
- measure **each item**: its box (a reference item is full width and has a real height — DSH's is min-height 34px, padding
  6px 8px, radius 12px, 16px glyph), whether its label is clipped (`scrollWidth > clientWidth`), and its glyph;
- check the item count against the container's height, so a container that collapsed its items shows up as a number;
- open it **twice in a row** and with a long label, because the state after the second click is a state too;
- do the same for dialogs, popovers, the model menu and the attach menu.

The squashed menu of 2026-10-17 was invisible to every closed-state assertion: a **descendant selector**
(`#tree .row-tools button`) had also sized the buttons inside the menu, so each item measured 20x16 with its label
clipped. The check now measures the open state item by item, and the selector is scoped to the action buttons only.

### 6. Walk the state matrix

| State | How to enter it | What to record |
|---|---|---|
| idle | fresh load, pointer elsewhere | every property that can change |
| hover | trusted pointer onto the element | the element **and its neighbours**; what appears, what hides |
| hover-left | trusted pointer away, then wait | does it clear? a leftover is a finding |
| focus / keyboard | focus it, press its keys | the state after the key |
| selected | choose it, move the pointer away | what persists — selection often differs from hover by persistence, not strength |
| disabled | find or force the condition | cursor, colour, and that nothing activates |
| live | while content arrives | which properties animate, at what rate |
| scroll | scroller at 0 / 50 / 100% | per element, per property |

### 7. Semantics, ARIA and keyboard

Check roles and states (`role=tree`/`treeitem`, `aria-expanded` on branches only, `aria-selected` on leaves,
`role=tablist` with `tab` and a roving tabindex), the accessible names of controls that show a value
("Access mode, current …"), and the keyboard path. Measure the reference's own reachability before copying a pattern:
DSH's tree is not focusable at all.

### 8. Keep the invariants when you refactor structure

Moving a node, wrapping it in a new container, or renaming a class silently removes old behaviour. After any structural
change, assert the invariants the old structure guaranteed: rows still render, hover still reveals, selection still
paints, nothing overlaps. Capture `window.onerror` and `unhandledrejection` in the probe and report them with a
failure — **a render that throws looks exactly like missing data**, which is how a `const` used before its declaration
took every session row out of the tree while the branch still rendered.

### 9. Make checks robust, so they judge the UI and not the fixture

Open a level only if it is closed (a blind click toggles); wait for an element rather than assuming a default state;
return an explicit error object instead of letting a missing element throw; keep the probe's own error path
diagnostic-rich (labels, kinds, page errors, the API's answer).

### 10. Turn the numbers into a check, and write the difference down

The outcome is not a screenshot; it is **numbers in a verifier** plus a row in the comparison document with one of
three verdicts: *match*, *fixed*, *difference kept with its reason and, when someone else owns it, its owner*. A
comparison without that document is a conversation, not a result.

## The miss ledger

Every miss appends a row. The ledger is the skill's memory, and a new session reads it first.

| Miss | What it cost | The rule now |
|---|---|---|
| Every control in a row had `cursor: default` | the owner felt it before any check did | measure every clickable element's cursor, from the DOM inventory |
| Selection marked with `aria-current` on the row | a screen reader did not get the tree's chosen state | `aria-selected` on the `treeitem`, stylesheet reads it |
| `aria-expanded="false"` on session leaves | told a screen reader a leaf has children | branches only |
| The row's controls drawn before the `…` | the same gestures as DSH in another order | `…` first, measured from DSH's own DOM |
| The age pushed inward by the controls | DSH's rightmost thing was not this UI's | one right-hand slot; the age and the controls share it |
| The age and controls **overlapped** a long name | the `…` disappeared and text showed between the icons | reserve the slot's width; assert label-right ≤ controls-left with the longest realistic name |
| A menu "looked transparent" while every background measured opaque | measured the colour, not the **clip**: `position: absolute` inside a scrolling sidebar was cut | box against every clipping ancestor; floating surfaces live in viewport coordinates |
| Menu items had no icons | compared the words, not the **anatomy** of an item | name each part (icon, label, shortcut, state mark) before comparing |
| `closeMenus` walked only `#tree` | the header menus needed two clicks to reopen | close every menu wrap; a menu that is not closed makes its trigger lie |
| A group heading drawn as an empty button | a control that does nothing appeared in a menu | headings are labels, tested by the field being present |
| "View options has three items", from a snapshot | the document claimed grouping and ordering were absent when the reference has all three groups | open the menu; a snapshot is a guess with a picture |
| 13/20 taken as the reading size | it was a paragraph in the reference's tool inspector | name the element the number came from |
| `--dsw-radius-panel` applied to the panes | the reference's panes measure 0; the token belongs to the composer card | a token is a claim, a computed style is a fact |
| A user turn called "full width, left-aligned" from a screenshot | the assertion went red against the correct right-aligned bubble | a screenshot is not a measurement; measure the **box** and settle disagreements with it |
| The selected tab's 2px underline missed for a cycle | computed-style reads cannot see a `::after` | read pseudo-elements and the reference's own `cssRules` |
| A `getComputedStyle` declaration read after restoring the state | reported `animation-name: none` on a working rule | snapshot every value before changing the state back |
| A descendant selector sized the buttons **inside an open menu** | the menu measured 20x16 per item and its labels were clipped; no closed-state assertion could see it | measure opened surfaces item by item (box, label clipping, glyph), and scope a rule to the control it is about with `>` |
| A `const` declared after its first use (TDZ) | threw for every session row; branches rendered and sessions vanished | declare a wrapper before anything appends to it; capture page errors in probes |
| A check clicked tree levels blindly | a blind click closes an open level; the fixture "lost" its rows | idempotent navigation and explicit precondition errors |
| The row's action buttons were "a bit too small" and had a background of their own | I had read DSH's `rowActions` rule in the research and never compared **our control's box** to it; our rule was also overridden by a higher-specificity `#workspaces-row > button` | every reference value noted in research becomes a **measured assertion** or an explicit not-measured row; measure `getBoundingClientRect`, not the rule you wrote |
| A backtick inside a page-script template literal, seven times | a syntax error and a debugging round each time | the check file's header states it; none of those comments use backticks |

## The inventory probe

Run this on **both** pages; it is the part of the comparison that cannot be remembered. It reports each interactive
element with the properties that have been missed before: cursor, hit-test, clipping and accessible name.

```js
// (run inside one page) — no backticks in this comment block when it is pasted into a template literal
(async () => {
  const wait = (ms) => new Promise((done) => setTimeout(done, ms))
  const interactive = [...document.querySelectorAll(
    'button, a[href], summary, input, textarea, select, [role="button"], [role="tab"], [role="menuitem"], [role="treeitem"], [tabindex]:not([tabindex="-1"])',
  )]
  const clips = (element) => {
    const rect = element.getBoundingClientRect()
    let clipped = false
    let current = element.parentElement
    while (current !== null) {
      const style = getComputedStyle(current)
      if (/auto|scroll|hidden|clip/.test(style.overflowX + style.overflowY)) {
        const outer = current.getBoundingClientRect()
        if (rect.left < outer.left - 1 || rect.right > outer.right + 1 || rect.top < outer.top - 1 || rect.bottom > outer.bottom + 1) clipped = true
      }
      current = current.parentElement
    }
    return clipped
  }
  return JSON.stringify(interactive.map((element) => {
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    const centre = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    return {
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute('role'),
      name: element.getAttribute('aria-label') ?? (element.textContent || '').trim().slice(0, 28),
      cursor: style.cursor,
      box: [Math.round(rect.width), Math.round(rect.height)],
      background: style.backgroundColor,
      hoverBackground: null,
      glyph: (() => { const svg = element.querySelector('svg'); if (svg === null) return null; const size = svg.getBoundingClientRect(); return [Math.round(size.width), Math.round(size.height)] })(),
      disabled: element.disabled === true || element.getAttribute('aria-disabled') === 'true',
      hitTest: centre === null ? null : centre === element || element.contains(centre),
      clipped: clips(element),
      visible: rect.width > 0 && rect.height > 0,
    }
  }))
})()
```

What to do with it:

- **`cursor` ≠ "pointer"** on an enabled control → fix, except a documented exception (text fields are `text`).
- **`hitTest` false** on a control that looks clickable → something is over it or it is clipped.
- **`clipped` true** → the element is cut by an ancestor; float it or give the ancestor room.
- **`visible` false but present** → it is hidden by state; make sure the state is the one you meant to measure.
- **`box` not the reference's class size** → the control is a member of a class you have not matched yet; note the reference's
  two classes (row action and icon button) and compare each separately.
- **`background` not the reference's** → a control that draws its own patch on a row or a panel is visible as a second
  surface; the reference's hover may change only the text colour.
- Compare the two lists **by anatomy**: an element present on the reference and absent here is a whole part missing,
  which is a stronger finding than any property.

## Definition of done for a comparison

A comparison is done when all of these are true:

1. The artifact was pinned, and the served script carries this round's marker.
2. The DOM inventory was run on both pages and diffed by anatomy, cursor, hit-test and clipping.
3. The coverage matrix has no unvisited cell — every cell is *match*, *fixed*, or *not measured with a reason*.
4. Content stress was tried: the longest, the empty, the unicode, the zero-row and the many-item case.
5. Occlusion was checked for every floating surface and every control near an edge.
6. The state matrix was walked for each state that exists, and re-measured after the change.
7. Every fix has an assertion, and the assertion judges the **number**, not a screenshot.
8. The difference document names each kept difference with its reason and, when it belongs to concurrent work, its owner.
9. Every miss found this round was appended to the ledger above.

A comparison that cannot state which cells it did **not** visit has not been thorough; it has been lucky.
