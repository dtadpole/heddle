---
title: Model Validation Library Tests
version: 1.0.0
description: Isolated tests of the catalogue selection, fingerprint and validation judgment rules.
grounded_in:
  - source: unit.test.mjs and the model-validation library
---

# `lib`

Component tests for [`../../lib.mjs`](../../lib.mjs), run with **no browser** and no provider calls.
[`unit.test.mjs`](unit.test.mjs) pins model targets, wire-format classification, fingerprints,
reasoning-level selection, minimum output budgets, cache lookup and pass/fail judgments.

```bash
node --test _tools_/model-validation/_tests_/lib/unit.test.mjs
```

Read [`../INDEX.md`](../INDEX.md) for the sibling wire-format suite.
