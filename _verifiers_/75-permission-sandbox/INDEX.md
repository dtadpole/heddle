---
title: Verifier 8 — Permission Sandbox
version: 1.0.0
description: a permission sandbox distinguishes read-only, workspace write and full access.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-11, listing the ten verifiers
---

# `75-permission-sandbox`

Instance of this project's `_verifiers_`. **The claim it decides:** a permission sandbox distinguishes read-only, workspace write and full access.

A sandbox that has never refused anything is a sandbox nobody has tested. This part judges three modes that behave differently — a write inside the workspace, a write outside it, and the same write under each mode — and judges that a refusal names the boundary it enforced.

## Where it runs

**No browser.** The checks drive the CLI, a scripted endpoint or a local HTTP double; nothing here needs
a display or a window.

## What decides it

`check-sandbox.mjs` drives writes through the tools under each mode against a scripted endpoint.

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

[`../INDEX.md`](../INDEX.md) for the ten verifications, and
[`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the part this one decides.
