---
title: Tests
version: 1.0.0
description: The component test suites of the repository's tools, one instance per subject, kept apart from both the framework's source suite and the delivery verifiers.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-17, asking for a _tests_ type folder registered with reflection
---

# `_tests_`

Instance of the `_tests_` type (registered in
[type vocabulary](../../reflection/shared/_conventions_/core-conventions/type-vocabulary.md)). Holds the
**component tests of this repository's tooling**: the suites that judge one piece of code — a codec, a
parser, a rule, a verdict mapping — rather than a delivered capability.

## The three kinds of check, and why they are apart

| Home | Judges | Runs |
|---|---|---|
| [`test/`](../test/INDEX.md) | the framework's **shipped source** (TypeScript, compiled with the project) | `npm test` |
| `_tests_/` | this repository's **tools** — code that is imported or run and returns a result | `node --test _tests_/*/unit.test.mjs` |
| [`_verifiers_/`](../_verifiers_/INDEX.md) | **delivered capabilities**, end to end, with the `0`/`1`/`3` verdict contract | `sh _verifiers_/*/verify.sh` |

The split matters because the three answer different questions. A unit test that asserts a table lists a
name cannot show that anything works; a verifier that passes on a table lookup is not judging delivery.
The boundary used here: **a static fact about the code is a component test; a fact about a browser, a
page or a command boundary is a delivery claim.**

## What belongs in it

One instance folder per suite, kebab-case and named for its subject:

| Instance | The suite |
|---|---|
| [`browser-use/`](browser-use/INDEX.md) | the browser tool's helpers — frame codec, keys, viewport syntax, snapshot text, pagination are in the tool; this suite holds the rules |
| [`check-helpers/`](check-helpers/INDEX.md) | the machinery the verifier checks stand on — transcript finding and decoding, session listing, JSON extraction |
| [`verify-runner/`](verify-runner/INDEX.md) | the verdict mapping every verifier's result passes through |

## Running them

```bash
node --test _tests_/*/unit.test.mjs
```

No browser, no server and no build: these are the fast checks a change to a tool should pass before any
verifier is run.

## Read next

[`browser-use/INDEX.md`](browser-use/INDEX.md), [`check-helpers/INDEX.md`](check-helpers/INDEX.md) and
[`verify-runner/INDEX.md`](verify-runner/INDEX.md) for the suites; [`../test/INDEX.md`](../test/INDEX.md)
for the framework's own suite; [`../_verifiers_/INDEX.md`](../_verifiers_/INDEX.md) for the delivery
claims.
