---
title: Verify Runner Component Tests
version: 1.0.0
description: The verdict mapping every verifier's result passes through, judged directly.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-17, separating component tests from delivery verifiers
---

# `verify-runner`

Instance of [`_tests_`](../INDEX.md). Holds the component suite for
[`_tools_/verify-runner/`](../../_tools/verify-runner/INDEX.md):
[`unit.test.mjs`](unit.test.mjs) pins `classify`, `tapCounts` and `collectNames` — the mapping that decides
every verifier's `0`/`1`/`3`.

The rules under test are the ones a green run could hide behind: a skipped check is never a pass, a
failure outranks an unjudged check, and nothing collected is unjudged rather than passed.

## Run it

```bash
node --test _tests_/verify-runner/unit.test.mjs
```
