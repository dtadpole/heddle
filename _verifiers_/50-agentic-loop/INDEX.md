---
title: Verifier 5 — Agentic Loop
version: 1.0.0
description: the agentic loop runs with tool calls.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-11, listing the ten verifiers
---

# `50-agentic-loop`

Instance of this project's `_verifiers_`. **The claim it decides:** the agentic loop runs with tool calls.

A single model call is not a loop. This part judges that a turn completes a multi-step task, that each tool result is fed back for the next round, that the loop stops when the model stops asking for tools, that the round limit stops one that does not, and that an end-to-end run records and resumes.

## Where it runs

**No browser.** The checks drive the CLI, a scripted endpoint or a local HTTP double; nothing here needs
a display or a window.

## What decides it

`check.mjs` drives a scripted multi-round turn and reads the transcript, `check-end-to-end.mjs` runs the whole thing
from configuration, and `check-subagents.mjs` judges the delegation boundary: a child agent runs in its own
session, attributed to its parent, and its final answer returns as the parent's tool result.

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
- **Anything it has to spend to see.** Except where a check is named for the real
  backend, every fixture is local and the run is free.

## Read next

[`../INDEX.md`](../INDEX.md) for the verifications, and
[`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the part this one decides.
