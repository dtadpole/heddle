---
title: Web daemon supervisor rules
created: 2026-10-23T03:23:40Z
modified: 2026-10-23T05:30:26Z
version: 2.0.0
description: Unit and component tests for supervisor.mjs — backoff, slow retries, the health probe, the reclaim, the lock, and real servers that are killed, hang or are left behind.
grounded_in:
  - source: _tools_/web-daemon/supervisor.mjs
  - source: measurement on the owner's Mac, 2026-10-22, that launchd does not restart a loaded agent
---

# `supervisor-rules`

The rules [`supervisor.mjs`](../../supervisor.mjs) keeps, and the one behaviour it exists for: a server that exits
comes back, and a server that cannot start is reported instead of looped forever.

The pure rules (`nextAttempt`, `afterProbe`, `isOurLeftover`, `lockVerdict`) are judged directly; the loop against
real child processes: a server that is killed, one that hangs (it SIGSTOPs itself), a leftover of the same command on
the port and a stranger on it, and a second supervisor refused by the lock. The supervisor runs with the agent's
`PATH`, which has no `/usr/sbin`: a reclaim that relied on `PATH` for `lsof` passed here and failed under launchd.

```bash
node --test _tools_/web-daemon/_tests_/supervisor-rules/unit.test.mjs
```

**Browser mode: none.**

## Read next

[`../../INDEX.md`](../../INDEX.md) for the tool these rules belong to.
