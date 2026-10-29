---
title: Browser slot queue tests
version: 1.0.0
description: Unit tests for browser-slot. They cover first-come order, the slot count and integrator reservation, the memory gate, the coordinator's priority turn, ticket refresh and expiry, stale-holder recovery, the hand-made lock and run.
grounded_in:
  - source: _tools_/local-build/browser-slot.mjs
created: 2026-10-29T13:08:51Z
modified: 2026-10-29T13:50:08Z
---

# `browser-slot`

Each test gives the wrapper a temporary slot root, so no test sees the Mac's real browser slot. The tests
check:
- first come, first served, with one ticket per seat kept and refreshed across calls;
- `browser-cap` slots, the reserved slot serving only its role and the rest serving everyone else, and a holder
  beyond a lowered cap;
- the memory gate: free under 25% or swap at or over 7168M admits no one, with readings faked;
- `browser.next` first while queued, used up on take, not blocking when absent, ignored when old;
- a holder cleared only when it is older than 15 minutes and its pid is gone or was never recorded;
- a hand-made lock and the tool excluding each other;
- release by the holder only, unless forced;
- `run` releasing after the command and returning its status;
- a two-seat race giving the slot to exactly one;
- `status` reporting without changing anything.

```bash
node --test _tools_/local-build/_tests_/browser-slot/unit.test.mjs
```

**Browser mode: none.**

## Read next

[`../../browser-slot.md`](../../browser-slot.md) for the rules.
