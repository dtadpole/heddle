---
title: Verifier 3 — Context Management
version: 1.1.0
description: context is a surface over an append-only log, priced against the endpoint's window, and reduced cheaply before it is reduced expensively.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-11, listing the ten verifiers
  - source: _context_/dsh-mechanisms/dsh-context.md, the reading of DSH 0.2.0-rc.2 this part now follows
---

# `30-context-management`

Instance of this project's `_verifiers_`. **The claim it decides:** context is a **surface** over an
append-only log, priced by a meter against the routed endpoint's own window, and reduced cheaply
before it is reduced expensively.

A harness that sends the whole transcript forever eventually cannot send anything. This part judges
the seven things a person relying on it can feel: a rewrite shadows a conversation without erasing
it; the budget is the window the endpoint declares; trimming one oversized tool result can end the
pressure before a summary is paid for; a cut never separates a tool call from its result and never
shadows the system prompt; a summary that does not shrink is refused and the conversation is left
alone; a provider that says the conversation did not fit gets one reduction and one retry; and the
project's instruction files arrive as one durable baseline that follows an edit inside a byte budget.

## Where it runs

**No browser.** The checks drive the CLI, a scripted endpoint or a local HTTP double; nothing here needs
a display or a window.

## What decides it

`check.mjs` drives turns against a scripted endpoint and a local HTTP double, and reads three
things: the transcript (what was logged), `heddle context <session> --json` (what the model would
read), and `dist/` directly for the two properties a scripted provider cannot produce on demand —
a non-shrinking summary and a cut that falls inside a tool pair. Every fixture is local, so the
whole part is offline and free.

## Running it

```bash
sh verify.sh            # every check, with the verdict
sh verify.sh --list     # the check names, and why any was unjudged
sh verify.sh --json     # one parseable object
```

Exit `0` when the claim holds, `1` when it fails, `3` when it could not be judged. A
claim that could not be judged is never reported as holding, which is the runner's
whole reason for existing — see [`_tools_/verify-runner/`](../../_tools_/verify-runner/INDEX.md).

## What it deliberately does not judge

- **How well a model reasons.** Nothing here scores an answer's quality; the checks
  ask whether the mechanism works.
- **Image offload and the surface's interpreter channel.** DSH's surface has a third plan kind,
  `project`, which lets a plugin substitute the message an event derives to — that is how an image
  reference becomes a file id. heddle has no images, so the fold has no interpreter hook, and that is
  a deliberate omission rather than an untested one.
- **A runtime-context snapshot.** DSH inserts one sourced user message per step carrying the working
  directory and policy. heddle's equivalent is the instruction baseline plus the tool descriptions,
  so there is no separate snapshot to judge.
- **Anything it has to spend to see.** Except where a check is named for the real
  backend, every fixture is local and the run is free.

## Read next

[`../INDEX.md`](../INDEX.md) for the verifications, and
[`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the part this one decides.
