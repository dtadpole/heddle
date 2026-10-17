---
title: Verifier — Browser Session
version: 1.0.0
description: one browser session survives between command lines, and status and stop tell the truth about it.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-17, asking for a browser tool with the harness browser's session behaviour
---

# `browser-session`

Instance of this tool's `_verifiers_`. **The claim it decides:** the command line is a *session*, not a
launch per command — the browser the first command starts is the one the next command acts on, its
console and network history survive the boundary, `status` reports it truthfully, and `stop` ends it.

## Surface

**Headless.** Every command in this verifier runs against a headless browser with a state directory of
its own, because the claim is about the session rather than about the window; a run that opened a window
would take the machine's focus and could not run unattended.

## What it must get right

| # | Claim | Why it is not obvious |
|---|---|---|
| 1 | `start` opens a browser and records the session | a tool that starts nothing but says it did is indistinguishable from one that works |
| 2 | a later command finds the same session | a process per command would work for one action and lose every open tab, console message and request between actions |
| 3 | the console and the network survive the command boundary | they are events, and nothing replays them for a client that attaches afterwards |
| 4 | a screenshot is saved and named | a path that does not exist is a screenshot that was not taken |
| 5 | `stop` ends the session and clears its record | a stale state file makes the next start depend on a dead socket |
| 6 | a tool call starts a session when none is running | the first command should not need `start` first |
| 7 | the command line lists its tools and refuses an unknown one | the surface is discovered, not guessed |
| 8 | two named sessions have two browsers and two sets of tabs | two agents driving a browser at once must not fight over one selected page, and page ids from one session must not name a page in the other |

## What it deliberately does not judge

- **The page tools themselves.** [`browser-surface/`](../browser-surface/INDEX.md) does that, in one
  process, with one browser.
- **The window.** Headless is this verifier's surface, and a session check should not need a seat.
- **A login done by hand.** The profile is persistent, but signing in is a person's act and nothing here
  pretends to judge it.

## How it is judged

```bash
./verify.sh
```

Every command is spawned against a state directory inside the check's own fixture, so this never touches
the browser profile of the machine's session host.
