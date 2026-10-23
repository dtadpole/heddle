---
title: Verifier — Resizable Panels
created: 2026-10-11T22:50:16Z
modified: 2026-10-23T05:04:11Z
version: 1.1.0
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

## Running it

```bash
sh verify.sh            # every check, with the verdict
sh verify.sh --list     # the check names, and why any was unjudged
sh verify.sh --json     # one parseable object
```

Exit `0` when the claim holds, `1` when it fails, `3` when it could not be judged — a host without a browser
is the `3` case.

## Read next

[`checks.md`](checks.md) for what is resizable and what the part must get right; [`readings.md`](readings.md) for the measured verdicts; [`../INDEX.md`](../INDEX.md) for the verifications.
