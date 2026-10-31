---
title: Verify Runner Rules
version: 1.1.0
description: The verdict mapping every verifier's result passes through, judged directly.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-17, separating component tests from delivery verifiers
---

# `verdict-rules`

Instance of [`_tests_`](../INDEX.md). Holds [`unit.test.mjs`](unit.test.mjs) for
[`_tools_/verify-runner/`](../../INDEX.md): a skipped check is never a pass, a failure outranks an
unjudged check, nothing collected is unjudged, and the TAP parsing that reads all of it. And that a runner told to stop
(the lane gate's SIGTERM after a check file's time limit) ends every process its check started, one in its own process
group included, so a timed-out browser check leaves no orphans.

## Run it

```bash
node --test _tools_/verify-runner/_tests_/verdict-rules/unit.test.mjs
```
