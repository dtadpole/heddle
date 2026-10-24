---
title: Verify Runner
version: 3.0.0
description: Turns one check file into the project's verdict, and holds the fixtures, doubles and browser wrapper the checks are written with.
grounded_in:
  - source: human-authored
---

# `verify-runner`

Holds the two halves of one job — making a verifier's result **honest** and making a verifier's check
**writable**:

| File | Half |
|---|---|
| [`run.mjs`](run.mjs) | the judge: runs a check under Node's test runner, reads the TAP stream, exits with the verdict ([`judge.md`](judge.md)) |
| [`lib.mjs`](lib.mjs), [`browser.mjs`](browser.mjs) | what every check imports: CLI runners, scripted doubles, fixtures, transcripts, `skipUnless`, the one-page browser ([`library.md`](library.md)) |
| [`lane.mjs`](lane.mjs) | the lane gate: does a merge candidate break anything, alone (D-042) or against `main`'s baseline (D-048) ([`lane-gate.md`](lane-gate.md)) |
| [`all.mjs`](all.mjs) | the stricter question: is every part met, an unjudged part counting as not met |
| [`lib.d.mts`](lib.d.mts) | the names a TypeScript test may import from the library |
| [`_tests_/`](_tests_/INDEX.md) | the component suites: verdict, library and lane rules |
| [`completion-evidence.md`](completion-evidence.md) | the 2026-10-18 complete verifier sweep, with its counters and revisions |

## The verdict contract

| Exit | Meaning |
|---|---|
| `0` | every check passed |
| `1` | at least one check failed |
| `3` | nothing could be judged — a skip, or no checks at all |

## Read next

[`_verifiers_/INDEX.md`](../../_verifiers_/INDEX.md) for the verifications and the contract they keep, and
[`browser-use/INDEX.md`](../browser-use/INDEX.md) for the browser the page checks drive.
