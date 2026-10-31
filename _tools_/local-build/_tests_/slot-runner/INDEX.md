---
title: Local build slot runner
version: 1.1.0
description: Unit tests for the slot runner — who holds a slot, when it is released, and what status reports.
grounded_in:
  - source: _tools_/local-build/run
created: 2026-10-23T03:21:31Z
modified: 2026-10-31T02:30:00Z
---

# `slot-runner`

The rules the runner keeps: three slots at three jobs; a slot is released when the command ends, on a signal,
and not before; a killed owner's slot is reclaimed without deleting a live one; an hour-old stamp yields only
when no slot is free; `status` names each slot and exits non-zero when one is stale; usage and a missing cargo
are distinct failures. With a shared `CARGO_TARGET_DIR`, a switch of tree touches its tracked and untracked
`*.rs` files (never ignored ones or build output) and a rebuild from the same tree touches none; two trees build
one at a time, the second touching only after the first ends; the lock records cargo's pid; a dead lock is
reclaimed and a live one ends in 75; no target, `fmt` and `LOCAL_BUILD_TREE_GUARD=0` leave everything alone. Concurrency is proven by holding each fake cargo until released, not by timing, and a holder
whose folder is gone exits, so a failed test leaves no process behind.

```bash
node --test _tools_/local-build/_tests_/slot-runner/unit.test.mjs
```

**Browser mode: none.**

## Read next

[`../../INDEX.md`](../../INDEX.md) for the tool these rules belong to.
