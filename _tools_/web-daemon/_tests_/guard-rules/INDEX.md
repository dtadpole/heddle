---
title: Web daemon guard rules
version: 1.0.0
description: Component tests for guard.sh — the cases that tell a guard from a restart loop: port answering, port silent with the job running, port silent with the job gone, and the cooldown.
grounded_in:
  - source: _tools_/web-daemon/guard.sh
  - source: measurement on the owner's Mac, 2026-10-23, that a port-only guard kicked a supervisor mid-restart
---

# `guard-rules`

What [`guard.sh`](../guard.sh) must not do, and the four readings that separate a guard from a restart loop.

The claim is narrow: **act only when nothing is running the service**. A guard that acted on "the port did not
answer" kicked a supervisor that was already restarting the server — measured 2026-10-23 in `guard.log`, three
restores 75 s and 15 s apart — which killed the fresh server and started the restart over. So the tests drive the
whole script against stand-in `curl`, `launchctl` and `systemctl` commands that record what they were asked to do:

| Reading | What the guard must do |
|---|---|
| the port answers | nothing, and no log line |
| the port is silent, but the job is `running` (or the unit `active`) | nothing: the supervisor is mid-restart, not gone |
| the port is silent, the job is loaded but not running | kickstart it, and say which reading caused it |
| the port is silent, the job is not loaded | bootstrap from the plist, then kickstart |
| a second run inside the cooldown | read only, no second action |

```bash
node --test _tools_/web-daemon/_tests_/guard-rules/unit.test.mjs
```

**Browser mode: none.**

## Read next

[`../../INDEX.md`](../../INDEX.md) for the tool these rules belong to.
