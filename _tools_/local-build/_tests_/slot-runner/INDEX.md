---
title: Local build slot runner
version: 1.3.0
description: Unit tests for the slot runner — who holds a slot, when it is released, and what status reports.
grounded_in:
  - source: _tools_/local-build/run
created: 2026-10-23T03:21:31Z
modified: 2026-10-31T04:20:00Z
---

# `slot-runner`

The rules the runner keeps: three slots at three jobs; a slot is released when the command ends, on a signal,
and not before; a killed owner's slot is reclaimed without deleting a live one; an hour-old stamp yields only
when no slot is free; `status` names each slot and exits non-zero when one is stale; usage and a missing cargo
are distinct failures. With a shared `CARGO_TARGET_DIR`, a switch of tree touches its tracked and untracked
`*.rs` files (never ignored ones or build output) and a rebuild from the same tree touches none; two trees build
one at a time, the second touching only after the first ends; the lock records cargo's pid; a dead lock is
reclaimed and a live one ends in 75; no target, `fmt` and `LOCAL_BUILD_TREE_GUARD=0` leave everything alone. A `--ts` run takes a ts slot from a
pool of two apart from the cargo slots (a third waits, cargo does not), every node it starts gets
`--test-concurrency=4` from a shim first on `PATH`, `ts-cap` sets the pool alone, and it adds no `-j`, leaves a
target alone and needs a command that exists. The queue serves the waiter that came first though a later one
polls thirty times as often; a live waiter ahead holds a free slot from a newcomer (75, the newcomer's ticket
gone); a dead waiter or one silent past 300 s is dropped and one silent past 60 s passed over; `.next` puts the
seat or tree it names first once and an hour-old one is ignored; `status` lists the queue in serving order and
changes nothing; a waiter stopped by `TERM` exits 143 and leaves the queue. Concurrency is proven by holding each fake cargo until released, not by timing, and a holder
whose folder is gone exits, so a failed test leaves no process behind.

```bash
node --test _tools_/local-build/_tests_/slot-runner/unit.test.mjs
```

**Browser mode: none.**

## Read next

[`../../INDEX.md`](../../INDEX.md) for the tool these rules belong to.
