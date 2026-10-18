---
title: Heddle's Trajectory against DSH's, measured
version: 1.0.0
description: The state matrix, the per-element numbers and the fixes of the trajectory comparison loop.
grounded_in:
  - source: browser
    detail: DSH 0.2.0-rc.2 at http://127.0.0.1:8080/ and heddle at http://localhost:8082/, 2026-10-17
---

# Trajectory: heddle against DSH

The loop follows the ui-comparison procedure: pin the artifacts, enumerate the state matrix, measure per
element and per property, reset between states, attribute each property to its driver, fix the driver,
re-measure, and turn the numbers into assertions.

## Pinned artifacts

| Artifact | Pinned |
|---|---|
| DSH | version 0.2.0-rc.2, `http://127.0.0.1:8080/`, session `context-mgmt` |
| heddle | HEAD `79f614b`, `dist/server/page.html` built 2026-10-17 16:46:46, daemon restarted 16:47:14 to serve it; markers read from the served page: accordion, full-bleed panes and split grip all present |

## State matrix

| State | Status |
|---|---|
| idle table | **measured** (batch A) |
| row hover / hover-left | pending (batch B) |
| selected row + details open | pending (batch B) |
| five tabs (Summary/Payload/Result/Schema/Timing) | pending (batch C) |
| scroll 0/25/50/75/100% | pending (batch D) |
| collapsed turns / calls, search | pending (batch D) |
| timeline focus drag | pending (batch D) |
| narrow (1000px) / wide (1600px) | pending (all) |

## Batch A — table geometry and typography (measured once each side)

| Metric | DSH | heddle | Verdict |
|---|---|---|---|
| table font | 12px / -apple-system | 12px / -apple-system | agree |
| row height | 30px | 30px | agree |
| event column | 122px | 122px | agree |
| kind tag height | 19px | 19px | agree |
| kind tag font | 10px / 650 | 10px / 650 | agree |
| kind tag letter-spacing | 0.35px | 0.35px | agree |
| kind tag padding | 0 5px | 0 5px | agree |
| kind tag radius | **4px** | 3px | **fixed → 4px** |
| USER tag | #7aaaff on #34415b | #6ea8f7 on 16% mix | **fixed → measured pair** |
| ASSISTANT tag | rgb(148,116,188) on #352f3a | #b29bfa on 16% mix | **fixed → measured pair** |
| TOOL tag | #dd8629 on #27241f | #d9a441 on 18% mix | **fixed → measured pair** |
| CONTEXT tag | #59c984 on #233c2c | #6ee7a0 on 16% mix | **fixed → measured pair** |

Driver of every disagreement here was the palette: heddle had mixed translucent approximations while DSH
paints opaque tag backgrounds from its token scale. The fix writes the measured opaque colours, so the
tag now sits on the same ground as the row (which a translucent mix could not guarantee).

## Batch B — row states (measured once each side)

| Metric | DSH | heddle | Verdict |
|---|---|---|---|
| idle row background | transparent | transparent | agree |
| idle row text colour | rgb(249,250,251) | rgb(249,250,251) | agree |
| row height | 30px | 30px | agree |
| selected row background | **rgba(255,255,255,0.14)** | 10% mix | **fixed → 14% white** |
| selected marker | `aria-selected="true"` + `data-selected="true"` | `data-selected="true"` | agree in effect; heddle adds no aria-selected |

The driver of the selection difference was the **paint value**, not the mechanism: both UIs mark the row
with a data attribute and paint the whole row, but heddle mixed 10% and DSH paints 14% white. The rule now
names the measured paint directly (`rgba(255, 255, 255, .14)`) so a computed-style assertion can pin it.

Unknowns from this batch: DSH's **row hover** paint was not found in the stylesheet scan (its hover may be
applied on an inner element or a class outside the table), so heddle's hover stays what it was and is not
claimed to match. The trusted-hover computed values for both sides still need the pointer pass.

## Batch C — the details pane (measured once each side)

| Metric | DSH | heddle | Verdict |
|---|---|---|---|
| panel width | 441px | 440px | agree |
| tabs | 5, 34px tall, 13px/400 | 5, 34px tall, 13px/400 | agree |
| section heading | **24px, 13px/500, 20px line** | 23px, 13px/600 | **fixed** → 24px/500/20px |
| payload block face | **"SF Mono"** | `monospace` (inherited) | **fixed** → `var(--mono)` starting at SF Mono |
| Schema section | name, description, parameters JSON | same, rendered by the tested renderer | agree in content |
| accordion | Payload/Result/Schema/Timing headings, open | six sections (Hierarchy/Status first), open | agree in behaviour; heddle adds two sections |

Driver of both disagreements was **typography**, not layout: the pane width, tab strip and section structure
already matched, while heddle's heading was 1px short at weight 600 and the payload block never received the
mono face (its markup is a `code` element, and the rule named `pre`). The fix names the code element, puts
the measured "SF Mono" first in the mono stack, and gives the headings DSH's 24px/500/20px.

## Batch D — toolbar and lane strip (measured once each side)

| Metric | DSH | heddle | Verdict |
|---|---|---|---|
| toolbar height | 28px | 34px | **fixed → 28px** |
| toolbar button | 20px tall, 8px radius, rgb(173,178,184) | 20px, 4px radius, text-3 | **fixed → 8px and the measured colour** |
| search input | 149×18px | 140×16px | **fixed → 149×18 (the box widened for the icon)** |
| lane strip | Input/Model/Tools, 51px | input/model/tools, 72px | **fixed → 51px, capitalised-in-css-free labels** |
| lane label | 10px/400, rgb(129,133,140), no transform, no tracking | 8px/10px mono, uppercase, .04em | **fixed → measured typography** |

Driver of the chrome disagreements was **the control scale**, not structure: both sides have the same three
toggle buttons, one search field and three lanes, but heddle had been built on an 8px-mono lane label and a
34px bar while DSH uses a 10px sentence-case label inside a 28px bar. The strip is content-driven, so the
tolerance is stated: 51px ±5px; the measurement lands at 51 after dropping the separate legend (DSH has no
legend row) and giving each of the three lanes 15px.

## Unknowns (not measured, never filled in from plausibility)

- DSH's SYSTEM and COMPACTED tag colours: those rows were not in the rendered window (virtualised table).
- DSH's table header row: no `thead`/`th` found in the DOM; its header may be a separate sticky element.
- DSH tool-row internals (name/args/result grid): measured later, beside heddle's, in batch C/D.
- heddle's live page could not be re-measured through the proxy during this round (it served "No session"
  after the restart); the assertions in the part 9 check measure the same build on its own fixture server.

## Structural notes from DSH's accessibility tree (2026-10-17)

The a11y snapshot names what CSS cannot: the toolbar controls are **"Use actual duration"**, **"Collapse
turns"** and **"Collapse calls"** (heddle labels them Duration/Turns/Calls — same functions, shorter labels);
the search field is "Search trajectory"; the timeline region is "Trajectory timeline" with "Load earlier
history" and the three lanes Input/Model/Tools. The details pane's separator is a real `separator` with
`orientation=vertical` and description **"Drag to resize. Double-click to reset."**; its Summary sections are
Hierarchy (with an "Assistant Message" button), Status, Payload (a JSON tree with Expand), Result, Schema
(the tool name, its description, a "Parameters" heading and a JSON tree) and Timing (Started with a unix
timestamp button, Duration). Heddle's details separator now carries the same stated gestures and resets on
double-click, asserted in part 9.

Still unknown: DSH's table header row (no `thead`/`th` in the DOM, and no "Event"/"Content" labels were found
by text) and the SYSTEM/COMPACTED tag colours (those rows were outside the rendered window in every scan).

## Round 5 (2026-10-17): the browser automation tools went away

The session's MCP browser tools (`select_page`, `evaluate_script`, `take_snapshot`, `screenshot`) are no longer
in the tool list, and the browser helper the checks use (`_tools_/browser-use/browser.mjs`) exposes only
`openBrowser` — no pointer dispatch, no viewport emulation. So this round could not take new live
measurements, and it did not invent any: the remaining states are listed below as **not measured**, not as
agreement.

- **row hover / hover-left**: not measured on either side. No tool in this session can produce a trusted
  pointer hover (a synthetic `pointerover` does not trigger CSS `:hover`), so the hover paint and its reset
  must wait for a CDP-capable harness. Heddle's declared hover (`#tr-table tbody tr:hover { background:
  var(--hover) }`) is known from source; DSH's paint is not.
- **narrow / wide viewport geometry**: not measured. Viewport emulation is not available in this session's
  tooling; the geometry pair from batch A/C stands at the current window only.
- **scroll positions 0/25/50/75/100% and virtualisation**: not measured. DSH's trajectory is virtualised
  (its a11y tree exposes a window of rows and a "Load earlier history" control); heddle renders every row.
  Whether that is a defect or a deliberate trade for heddle's ledger sizes is a decision for a round that can
  measure it, not for this one.
- **collapsed turns / collapsed calls / search**: not measured beyond the toolbar controls' geometry.

What is still available: the part 9 verifier launches its own headless browser and evaluates the page, so a
proper re-measurement should be written **as a check** (or a script using the same helper) rather than as an
interactive session. That is the next round's route.

## Round 6: the trusted-input route exists, and the probe needs one fix

The session's interactive browser tools did not come back, but the repository's own
[`_tools_/browser-use`](../../_tools_/browser-use/INDEX.md) library does expose exactly what round 5 said was
missing: `hover` moves the **real pointer** over CDP (`Input.dispatchMouseEvent`), `resizePage` sets the
viewport (`Emulation.setDeviceMetricsOverride`), and `page.send` reaches any protocol method. So the route for
the remaining states is a script, not an interactive session.

[`probe-trajectory.mjs`](probe-trajectory.mjs) is that instrument: per side it reads the idle rows, moves a
trusted pointer onto a row and reads the hover paint, moves it away and re-reads (the hover-left reset), then
re-measures the table, its first-row cells and the details panel at 1000px and 1600px, and finally records how
many rows live in the DOM at scroll 0/25/50/75/100%. Its first two runs did **not** produce usable numbers:
its visible-row predicate (`rect.width > 0`) rejects table rows in this layout, and the DSH run needs a
confirmed session selector in a fresh profile (it opened no session, so its trajectory never rendered).
The honest state is: the instrument is in place and runs end to end, the numbers are not yet trustworthy.

Next round: fix the predicate to test the cells' rects (or `display`/`offsetParent`) and select DSH's session
through a selector verified in a snapshot, then run the matrix and record the numbers.

## Batch B2 — trusted hover, and the viewport pair (probe, headless CDP)

The probe drives `hover` through `_tools_/browser-use`, so the pointer is **trusted** (CDP
`Input.dispatchMouseEvent`) and CSS `:hover` really applies. Rows are two-column trajectory rows on both sides.

| Metric | DSH | heddle (before) | Verdict |
|---|---|---|---|
| idle row | transparent | transparent | agree |
| **hovered row** | **rgba(0,0,0,0)** | rgb(44,44,44) | **fixed → no hover paint, as DSH** |
| after pointer leaves | transparent | transparent | agree; the reset is proven, not assumed |
| event column @1000 / @1600 | 122 / 122 | 122 / 122 | agree |
| table width @1000 / @1600 | 937 / 1313 | 644 / 1244 | **driver: sidebar width**, not table layout |

DSH paints **no** row hover: its affordance is the selected state (measured earlier at 14% white). Heddle had
added a hover tint; it is removed so the states agree, and the part 9 check now moves a **real pointer** over a
row over CDP and asserts the row stays transparent (`browser.send('Input.dispatchMouseEvent')`).

The table-width pair exposes a second, larger difference whose driver is not the table: heddle keeps its
416px sidebar at 1000px and squeezes the content column to 522px, while DSH's content is 815px wide there —
consistent with DSH collapsing or narrowing its navigation pane at narrow widths. That is a responsive-state
gap in the shell, not in the trajectory, and is recorded for a round that can measure the collapse breakpoint.

Still not measured: scroll 0/25/50/75/100% row counts (the probe's scroll block was dropped when the row
predicate was rewritten) and the collapsed turns/calls/search states.

## Batch D2 — scroll, collapse and search (probe, headless CDP)

| State | DSH | heddle | Verdict |
|---|---|---|---|
| DOM rows at 0/25/50/75/100% | **34 at every position** (scroller `Y0dWHa_tablePane`) | no scrollable pane on the measured session (no overflow), full render | **structural difference**: DSH virtualises, heddle renders every row |
| collapse turns | control found ("Collapse turns"), row count unchanged in the same task | 15 → **6** → restored 15 | heddle works; DSH unmeasured (its render is async) |
| collapse calls | control found, count unchanged in the same task | 15 → 15 (no subcall rows to fold) | heddle's data has no subcalls; DSH unmeasured |
| search "not-a-real-term-xyz" | 28 → 28 → 28 in the same task | 15 → **4** → cleared 15 | heddle filters and clears; DSH unmeasured (debounced) |

Attribution: the scroll difference is **virtualisation, not a paint detail** — DSH keeps a ~34-row window in
the DOM whatever the scroll position, while heddle renders the whole ledger. Adopting virtualisation is a
structural feature (windowed rendering, scroll anchoring, a page of history), not a comparison-round fix, and
is recorded as a decision for the owner rather than quietly copied.

The DSH collapse and search numbers are **not trustworthy yet**: both are rendered asynchronously/debounced,
and the probe clicks and reads in the same task, so the unchanged counts prove nothing. The probe needs a
settle wait after each toggle and after typing (plus the async render), the same class of bug the split-bar
check hit earlier. Until then those two states are unknown on the DSH side; heddle's side is measured and
works.

## Round 9: settle waits turned the async states into numbers, and the sidebar collapse is confirmed

With a 600–700ms settle after every toggle and keystroke, the DSH side reads:

| State | DSH | heddle |
|---|---|---|
| collapse turns | 34 → **28** rows (the label flips to "Expand turns", so the restore click in the probe found no control) | 15 → **6** → 15 |
| collapse calls | 28 → **11** rows (same label flip) | 15 → 15 (no call rows in this session) |
| search "not-a-real-term-xyz" | 11 → 11 (still unfiltered) | 15 → **4** → 15 |
| sidebar at 1000px | **35px** (collapsed to a rail) | 352px (unchanged) |
| sidebar at 1600px | 256px | 352px |

What this settles:

- **DSH's collapse controls really do fold rows** (turns 34→28, calls 28→11). Heddle's turns collapse is
  measured and works (15→6); its calls collapse changes nothing on a session with no call rows, so it is not
  yet evidence of disagreement — a session with tool calls is needed to compare this state.
- **DSH's search is still unmeasured**: a native value setter plus an `input` event left the row count at 11
  under a nonsense term. Its input is likely controlled and needs real key events (`Input.insertText` /
  `Input.dispatchKeyEvent`) before the debounce; that is the probe's next fix, not a heddle finding.
- **The narrow-width difference is now named**: DSH collapses its navigation to a **35px rail** at 1000px;
  heddle keeps its 352px sidebar and squeezes the trajectory content column to 522px against DSH's 815px.
  The driver is a responsive sidebar collapse in the shell, which heddle does not have.

Deliberate difference still open: **virtualisation** (DSH keeps ~34 DOM rows at every scroll position; heddle
renders the ledger whole). Recorded for the owner's decision rather than copied silently.

## Round 10: real keys, and two DSH semantics that are still not established

The probe now types into the search field with real CDP key events (`Input.insertText`, then Backspace via
`dispatchKeyEvent`), not a native value setter. The measured result:

| State | DSH | heddle |
|---|---|---|
| search field receives the term | yes (value and focus verified) | yes |
| rows after "not-a-real-term-xyz" | **42 → 42 → 42** | 15 → **4** → 15 |
| collapse turns | 52 → 36, restore read 38 (label flipped to "Expand turns", so the probe's second click missed it) | 15 → 6 → 15 |
| collapse calls | 42 → 42 (state already crossed by the turns toggle) | 15 → 15 |

Two DSH semantics are therefore **not established**, and are recorded as such:

- **Search**: with a real term typed and the input verified, DSH's row count does not change. That is consistent
  with a **find/jump or highlight** search (which keeps the rows) rather than heddle's row **filter**. One probe
  cannot tell which: the next one must search a real term and read for a highlight element, an
  `aria-activedescendant`, or a scroll jump. Heddle's filtering remains its own model until DSH's is measured;
  it is not claimed as agreement or as a defect.
- **Collapse controls**: DSH's labels flip between "Collapse …" and "Expand …", so a probe that re-finds the
  control by its original label toggles the wrong state (the crossed counts above). The fix is to find the
  control by position or `aria-pressed` and to reset between the two toggles. Heddle's own collapse is stable
  and measured (turns 15→6→15).
