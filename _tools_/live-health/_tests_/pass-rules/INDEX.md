---
title: pass rules
version: 1.0.0
description: Unit tests for every judgment a live-health pass makes, run with node --test and no browser.
grounded_in:
  - source: the working agreement that key functions carry test cases, 2026-10-17
created: 2026-10-23T05:10:55Z
modified: 2026-10-23T05:10:55Z
---

# `pass-rules`

Instance of [`_tests_`](../INDEX.md). [`unit.test.mjs`](unit.test.mjs) judges each rule in
[`../../rules.mjs`](../../rules.mjs) from numbers and strings, so a wrong rule fails here before it can pass
a broken deployment. Reading a real page stays the integration step, in `probe.mjs`.

```bash
node --test _tools_/live-health/_tests_/pass-rules/unit.test.mjs
```

## Read next

[`../../INDEX.md`](../../INDEX.md).
