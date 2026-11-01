---
title: Check Library Rules
version: 1.2.0
description: The rules the verifier checks stand on, judged without a browser or a CLI.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-17, separating component tests from delivery verifiers
---

# `helper-rules`

Instance of [`_tests_`](../INDEX.md). Holds [`unit.test.mjs`](unit.test.mjs) for
[`lib.mjs`](../../lib.mjs), the library every check imports: how a transcript is found and decoded in either store
layout, how sessions are listed, how a JSON document is taken from a noisy stream, how a directory is
fingerprinted, what `skipUnless` reports, how per-run evidence paths preserve earlier artifacts, and which
harness a check runs — `heddleCommand` and `harnessEntry` name the `HEDDLE_BIN` binary when it is set, and
`inProcessOnly` leaves a check that calls `dist/` modules unjudged there. And that `endChild` stops a harness
within its bound: SIGTERM first, SIGKILL for one that ignores it.

The rule it guards is the quiet one: a helper that reads the wrong file turns a check into a claim about
nothing.

## Run it

```bash
node --test _tools_/verify-runner/_tests_/helper-rules/unit.test.mjs
```
