---
title: 87-resizable-panels — what it must get right
created: 2026-10-23T05:06:41Z
modified: 2026-10-23T05:06:41Z
level: L3
version: 1.0.0
description: What is resizable, the claims 87-resizable-panels judges, how, and what it deliberately leaves out.
status: unverified
grounded_in:
  - source: moved verbatim from _verifiers_/87-resizable-panels/INDEX.md@1.0.0
---

# 87-resizable-panels — what it must get right

## What is resizable today, and what is not

The layout is a sidebar and one content column, so what can be resized is the boundary between them —
`#gutter-left`. There is **no separate right panel**: the Chat/Trajectory views and the composer share the
content column. If a right panel is added later, it needs a second divider and a second claim; this part does
not pretend to judge one.

## What it must get right

| # | Claim | Why it is not obvious |
|---|---|---|
| 1 | the divider is a **control**, not a styled border | `role="separator"` with a tabindex is what makes it keyboard reachable, and the value attributes are what let assistive technology report the width |
| 2 | dragging with a pointer changes the width, and the stored width matches what is drawn | a stored number that disagrees with the layout is how a "remembered" width comes back wrong |
| 3 | a drag past the limits leaves room to work, and the sidebar cannot be dragged away entirely | a panel wider than the window reads as the app being broken, not as a choice |
| 4 | the arrow keys move it, in both directions | a control that only works with a mouse is half a control |
| 5 | the width is restored after a reload | "remembered" is the whole point of letting someone set it |

## How it is judged

A real browser, because every one of these claims is about layout: a divider that looks draggable and is not
answers `200` and shows the same pixels. Measured, and this is why the check exists: an early version called
`setPointerCapture` unguarded, and a pointer the browser is not tracking threw before the drag listeners were
bound — the divider rendered, the cursor changed, and dragging did nothing.

The drag is exercised by dispatching events that **carry coordinates**, because a synthetic `PointerEvent`
carries none for a pointer the browser is not tracking, and a check that dispatched one would read `0` and
report a working divider as broken. That is the same trap, from the other side, and the comment in the check
says so.

## What it deliberately does not judge

- **A right panel.** There is not one yet. Adding a divider for a panel that does not exist would judge a
  design rather than a behaviour.
- **Touch gestures.** `touch-action: none` is set on the divider so a touch drag pans nothing else, and the
  pointer events are the same ones a touch produces — but no touch device is available here, so it is not
  claimed.
- **The exact pixel of a drag.** The check asserts direction and bounds rather than a number, because a
  pointer-driven width that lands one pixel out is correct.
