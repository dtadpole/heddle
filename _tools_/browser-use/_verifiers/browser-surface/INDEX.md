---
title: Verifier — Browser Surface
version: 1.1.0
description: every page tool acts on the element a snapshot named, and a dialog or a navigation does not silently change what that means.
grounded_in:
  - source: the tool surface recorded in _context_/dsh-browser-mcp
  - source: owner statement in the dsh session, 2026-10-17, asking for the tool to be verified against a real browser
---

# `browser-surface`

Instance of this tool's `_verifiers_`. **The claim it decides:** the page tools — snapshot, click, fill,
fill_form, type, press, hover, drag, upload, dialogs, wait, evaluate, screenshot, pages, navigation,
console, network and emulation — each do what their name says on a real page, and the uid a snapshot
hands out is the element the next action hits.

## Surface

**Headless by default**, so it runs unattended on a machine with no seat and never takes the focus.
Run it headed to watch it work:

```bash
HEDDLE_BROWSER_HEADED=1 ./verify.sh
```

The headed run additionally judges the one claim a headless run cannot: that the browser really was a
visible window (`headless: false`), not a headless one pretending to be a browser. That check is a skip
— an **unjudged** verdict, never a pass — on a headless run.

## What it must get right

| # | Claim | Why it is not obvious |
|---|---|---|
| 1 | a snapshot names the page and its elements | the tree is the interface; a uid that names nothing is worse than no uid |
| 2 | a click hits the element the uid named, after scrolling it into view | `element.click()` passes a page that listens for real pointer events; a scripted check would not see the difference |
| 3 | fill reaches a framework's state | assigning `value` leaves React's state stale; the prototype setter plus `input`/`change` is what a keyboard does |
| 4 | typing and keys reach a key listener, and `Space` activates a focused native button | a value that appears without the events is not typing; a key's name is not always its DOM value, and a button answers the space bar only for `key: ' '` |
| 5 | hover and drag move a real mouse | a synthetic event carries no coordinates for a pointer the browser is not tracking |
| 6 | a file input receives files | only the protocol's own `DOM.setFileInputFiles` does this |
| 7 | a dialog blocks the tools that must not run through it, until it is answered | a click that opens a `confirm` leaves a call unanswered; the tool must not deadlock on itself |
| 8 | the console and the network are readable, one message and one request at a time | the two things a page's own behaviour is judged by |
| 9 | screenshots are real images, of the viewport, the page, and one element | a blank image passes a size check but not this one |
| 10 | navigation reaches URL, back, forward and reload, and the old uids die with the document | clicking a lookalike element from the previous page is the silent failure |
| 11 | emulation changes what the page believes, and a second call replaces rather than adds | `matchMedia` and `innerWidth` are the page's own reading |
| 12 | the last page cannot be closed | the tool keeps the one page it needs |

## What it deliberately does not judge

- **The session between commands.** That is [`browser-session/`](../browser-session/INDEX.md).
- **The tools it does not implement.** Lighthouse, performance tracing, CSS styles, screencasts and heap
  snapshots are named as absent in the tool's index; there is nothing here to judge.
- **Whether the page's own product logic is right.** The fixture page is this check's, not heddle's.

## How it is judged

```bash
./verify.sh
HEDDLE_BROWSER_HEADED=1 node --test check.mjs
```

The page is served by the check itself on loopback, so it spends nothing and needs no network. Every
behaviour is read back from the page's text, its console, or the network log — never from the tool's own
account of what it did.
