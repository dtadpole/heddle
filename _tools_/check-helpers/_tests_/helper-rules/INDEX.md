---
title: Check Helpers Rules
version: 1.0.0
description: The rules the verifier checks stand on, judged without a browser or a CLI.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-17, separating component tests from delivery verifiers
---

# `helper-rules`

Instance of [`_tests_`](../INDEX.md). Holds [`unit.test.mjs`](unit.test.mjs) for
[`_tools_/check-helpers/`](../../INDEX.md): how a transcript is found and decoded in either store
layout, how sessions are listed, how a JSON document is taken from a noisy stream, how a directory is
fingerprinted, and what `skipUnless` reports.

The rule it guards is the quiet one: a helper that reads the wrong file turns a check into a claim about
nothing.

## Run it

```bash
node --test _tools_/check-helpers/_tests_/helper-rules/unit.test.mjs
```
