---
title: Load check report
version: 1.0.0
description: Unit tests for the load-check report — its parsers, its thresholds and the exit code it hands the coordinator.
grounded_in:
  - source: _tools_/load-check/load-check.mjs
---

# `report`

The rules the report keeps: every source is parsed from the real command's text; a slot is busy, stale or
free from its owner file in either format; processes are grouped by the seat worktree that holds their
working directory; disk, load and swap each have a warn and a stop line; the worst finding decides the exit
code, and a stale slot is never silent.

```bash
node --test _tools_/load-check/_tests_/report/unit.test.mjs
```

**Browser mode: none.**

## Read next

[`../../INDEX.md`](../../INDEX.md) for the tool these rules belong to.
