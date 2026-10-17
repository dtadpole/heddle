---
title: Verifier 2 — Streaming
version: 1.0.0
description: streaming text and reasoning appear in a browser while the model is still writing.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-11, listing the ten verifiers
---

# `20-streaming`

Instance of this project's `_verifiers_`. **The claim it decides:** streaming text and reasoning arrive as separate deltas while the model is still writing, judged without any Web UI.

A stream that is only visible after it ends is not a stream. This part judges that main content and reasoning arrive as **distinct deltas**, that they are emitted **before** the turn completes, and that the same deltas are in the session record. It needs no browser and no server, so the streaming claim holds on its own.

## Where it runs

**No browser.** The checks drive the CLI, a scripted endpoint or a local HTTP double; nothing here needs
a display or a window.

## What decides it

`check.mjs` drives a turn against a local double that emits its deltas with gaps, watches `heddle --stream`, and asserts that reasoning and content deltas both arrive before the completion -- first observed at the delta, not at the end.

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
