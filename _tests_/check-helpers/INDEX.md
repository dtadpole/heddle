---
title: Check Helpers Component Tests
version: 1.0.0
description: The rules the verifier checks stand on, judged without a browser or a CLI.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-17, separating component tests from delivery verifiers
---

# `check-helpers`

Instance of [`_tests_`](../INDEX.md). Holds the component suite for
[`_tools_/check-helpers/`](../../_tools/check-helpers/INDEX.md), the machinery every verifier check
imports: [`unit.test.mjs`](unit.test.mjs) pins how a transcript is found and decoded, how sessions are
listed in either store layout, how a JSON document is taken from a noisy stream, how a directory is
fingerprinted, and what `skipUnless` reports.

The rule it guards is the quiet one: a helper that reads the wrong file turns a check into a claim about
nothing.

## Run it

```bash
node --test _tests_/check-helpers/unit.test.mjs
```

## What it does not judge

Whether any capability is delivered — that is each verifier's own claim in
[`_verifiers_/`](../../_verifiers_/INDEX.md).
