---
title: Lane Gate Rules
version: 1.0.0
description: The lane gate's decision over a candidate's verifier results, and its command line, judged without running a verifier.
grounded_in:
  - source: decision D-042, a branch merges when the gate is green and no lane verifier fails, so unjudged checks never hold a merge
---

# `lane-rules`

Instance of [`_tests_`](../INDEX.md). Holds [`unit.test.mjs`](unit.test.mjs) for [`lane.mjs`](../../lane.mjs): that
unjudged checks leave the lane green, that one failing check or a verdict of `1` turns it red and names the file, that
a check file with no verdict (a timeout, a crash) is broken and broken is red, that the verdict is read from the last
line of the runner's output, and that every part named on the command line is judged — the first version dropped the
first part whenever `--timeout` was absent. And, for D-048's baseline mode: that a `--list` run is read as named checks with
its exit code as the verdict, that only a lost pass regresses (a new failure of an unjudged check is listed, not blocking),
that a baseline pass which disappears from the run counts as a regression, and that a regression blocks only if its
file fails it again on a re-run (one that passes is named flaky).

## Run it

```bash
node --test _tools_/verify-runner/_tests_/lane-rules/unit.test.mjs
```
