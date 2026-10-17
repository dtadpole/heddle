---
title: Runner
version: 1.1.0
description: Turns one check file into the project's verdict, because node --test alone cannot.
grounded_in:
  - source: human-authored
---

# `verify-runner`

Holds [`run.mjs`](run.mjs), the only thing that decides a verifier's verdict; its component tests live
in [`_tests_/verdict-rules/`](_tests_/verdict-rules/INDEX.md). It runs
a check file under Node's test runner, reads the TAP stream, and exits with the
project's three-valued contract:

| Exit | Meaning |
|---|---|
| `0` | every check passed |
| `1` | at least one check failed |
| `3` | nothing could be judged — a skip, or no checks at all |

## Why it exists rather than plain `node --test`

Measured on Node v24.19.0: a suite whose checks all skip exits `0`. That is the one
answer that must never be given for "nothing was judged", and it is the whole reason
this wrapper exists. A part of the goal that is not built yet must read as unjudged,
never as holding.

## Run it

```bash
node _tools_/verify-runner/run.mjs _verifiers_/10-llm-backends/check-model-service.mjs
node _tools_/verify-runner/run.mjs <check> --list    # the check names, and why any was unjudged
node _tools_/verify-runner/run.mjs <check> --json    # one parseable object
```

`--list` and `--json` return the same verdict as a plain run, because the verdict is
the result rather than a side effect of printing.

The rules themselves are component-tested without running a check:

```bash
node --test _tools_/verify-runner/_tests_/verdict-rules/unit.test.mjs
```

## Component tests

`classify`, `tapCounts` and `collectNames` carry the rules every verdict depends on, so they are
tested directly in [`_tests_/verdict-rules/`](_tests_/verdict-rules/INDEX.md) — no check file, no
child process, no browser. The
tests are the delivery claim's floor rather than a duplicate of it: a verifier proves a capability, and
these prove that the mapping which reads its result counts a skip as unjudged, puts a failure above a
skip, and never turns "nothing was judged" into a pass.

## Why the check helpers are not part of this tool

The fixtures, model doubles and CLI runners live next door in
[`check-helpers/`](../check-helpers/INDEX.md) rather than here, and the reason is the trust boundary
rather than taste.

- **This tool is only ever invoked as a process.** Every `verify.sh` runs
  `node _tools_/verify-runner/run.mjs <check>`; no check imports it. The judge reads a TAP stream and
  decides `0`/`1`/`3`, and a check cannot reach into that decision. `classify` is exported only for
  this tool's own component tests.
- **The arrow points one way.** A check imports the helpers in-process; the runner spawns the check.
  Merging would let a check import the module that also decides its verdict, and would give the judge
  a dependency on the harness's transcript decoder and on `browser-use` — every bug in a fixture would
  become a bug in verdict computation.
- **The consumers differ.** The helpers have 27 importing check files; the runner has the 15
  `verify.sh` scripts and nothing else. One is a library, the other a command with an exit contract.
- **They are tested apart.** This tool's mapping has nine component tests that spawn nothing; the
  helpers have their own suite. A change to a model double should not make anyone re-argue the verdict
  mapping.

Keeping them separate is what lets the runner stay small enough to read in one sitting — which is the
property a judge should have.

## The mapping it implements

`classify` is exported and documented because the mapping is the claim: no checks at
all is `3`, any failure is `1`, any skip is `3`, and only a run where every check
passed is `0`.

## Read next

[`_verifiers_/INDEX.md`](../../_verifiers_/INDEX.md) for the ten verifications and the
contract they keep, and [`../check-helpers/INDEX.md`](../check-helpers/INDEX.md) for the helpers a
check file imports.
