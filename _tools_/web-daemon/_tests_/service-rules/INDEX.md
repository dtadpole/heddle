---
title: Web daemon service rules
created: 2026-10-23T01:37:16Z
modified: 2026-10-23T05:14:51Z
version: 1.0.0
description: Unit tests for the readers and verdicts in service.mjs that 95-web-daemon and 96-deployment share.
grounded_in:
  - source: _tools_/web-daemon/service.mjs
---

# `service-rules`

The rules `service.mjs` keeps: each platform has one supervisor and one documented port; a unit file parses as
systemd reads it, resets included; an `ExecStart` line splits as systemd splits it; a command line names the
build, the checkout and the port for either build; each build is compared with the page file it serves; the
launch token is the newest one; the listener is the pid on the exact port; and a deployment checkout is main at
its tip or detached exactly at `origin/main`, and clean.

```bash
node --test _tools_/web-daemon/_tests_/service-rules/unit.test.mjs
```

**Browser mode: none.**

## Read next

[`../../INDEX.md`](../../INDEX.md) for the tool these rules belong to.
