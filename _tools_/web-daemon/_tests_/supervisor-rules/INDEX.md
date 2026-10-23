---
title: Web daemon supervisor rules
version: 1.0.0
description: Unit and component tests for supervisor.mjs — the backoff, the give-up decision, the command line, and a killed server actually coming back.
grounded_in:
  - source: _tools_/web-daemon/supervisor.mjs
  - source: measurement on the owner's Mac, 2026-10-22, that launchd does not restart a loaded agent
---

# `supervisor-rules`

The rules [`supervisor.mjs`](../supervisor.mjs) keeps, and the one behaviour it exists for: a server that exits
comes back, and a server that cannot start is reported instead of looped forever.

The pure rules are judged directly; the loop is judged against real child processes — a stand-in server that
records each start into a file — so "the server came back" is measured, not mocked.

```bash
node --test _tools_/web-daemon/_tests_/supervisor-rules/unit.test.mjs
```

**Browser mode: none.**

## Read next

[`../../INDEX.md`](../../INDEX.md) for the tool these rules belong to.
