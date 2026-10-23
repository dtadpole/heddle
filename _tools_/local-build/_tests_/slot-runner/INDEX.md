---
title: Local build slot runner
version: 1.0.0
description: Unit tests for the slot runner — who holds a slot, when it is released, and what status reports.
grounded_in:
  - source: _tools_/local-build/run
---

# `slot-runner`

The rules the runner keeps: three slots at three jobs; a slot is released when the command ends, on a signal,
and not before; a killed owner's slot is reclaimed without deleting a live one; an hour-old stamp yields only
when no slot is free; `status` names each slot and exits non-zero when one is stale; usage and a missing cargo
are distinct failures.

```bash
node --test _tools_/local-build/_tests_/slot-runner/unit.test.mjs
```

**Browser mode: none.**

## Read next

[`../../INDEX.md`](../../INDEX.md) for the tool these rules belong to.
