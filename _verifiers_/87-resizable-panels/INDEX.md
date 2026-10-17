---
title: Verifier — Resizable Panels
version: 1.0.0
description: the sidebar's width is the reader's choice, made with a pointer or a keyboard and remembered.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-11, asking for the left and right panels to be resizable
---

# `87-resizable-panels`

Instance of this project's `_verifiers_`. **The claim it decides:** a reader decides how much room the
sidebar gets, with a pointer **or** a keyboard, and the choice survives a reload.

It sits beside [`80-web-ui`](../80-web-ui/INDEX.md) because it judges the page's *shape* rather than its
content: not what a view says, but how much of the window it is given.

## Where it runs

**Headless browser.** The checks that need a page open a real Chrome with no window, through
[`_tools_/browser-use/`](../../_tools_/browser-use/INDEX.md); the rest drive the CLI and local HTTP
doubles. Nothing here needs a display, so it runs unattended.

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

## Running it

```bash
sh verify.sh            # every check, with the verdict
sh verify.sh --list     # the check names, and why any was unjudged
sh verify.sh --json     # one parseable object
```

Exit `0` when the claim holds, `1` when it fails, `3` when it could not be judged — a host without a browser
is the `3` case.
