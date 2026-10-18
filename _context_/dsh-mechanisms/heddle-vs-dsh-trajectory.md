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
