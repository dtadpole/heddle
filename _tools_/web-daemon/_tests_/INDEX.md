---
title: Web daemon component tests
version: 1.2.0
description: The component suites of the web-daemon tool, one folder per suite.
grounded_in:
  - source: _tools_/INDEX.md section Where the tests live
---

# `_tools_/web-daemon/_tests_`

The tool's component tests, beside its code. They need no running service, no network and no browser: one
suite judges the readers both daemon verifiers share, one judges the supervisor against real child processes, and
one runs the installer in throwaway checkouts with stand-in supervisor commands, so both platform branches are
judged on either platform.

| Suite | What it judges |
|---|---|
| [`service-rules/`](service-rules/INDEX.md) | how `service.mjs` reads a unit, a command line, a listener and a checkout, and the committed-main verdict |
| [`install-rules/`](install-rules/INDEX.md) | what `install.sh` renders and runs on Linux and macOS, what it refuses, and that a refusal writes nothing |
| [`supervisor-rules/`](supervisor-rules/INDEX.md) | the supervisor's backoff and its slow-retry policy, and that a killed server actually comes back |
| [`guard-rules/`](guard-rules/INDEX.md) | the guard acts on the job, not the port: nothing while a supervisor is mid-restart, a kickstart when the job is gone, and a cooldown |

```bash
node --test _tools_/web-daemon/_tests_/*/unit.test.mjs
```

## Read next

[`../INDEX.md`](../INDEX.md) for the tool.
