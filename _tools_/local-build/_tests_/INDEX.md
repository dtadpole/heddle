---
title: Local build component tests
version: 1.0.0
description: The component suites of the local-build tool, one folder per suite.
grounded_in:
  - source: _tools_/INDEX.md section Where the tests live
created: 2026-10-23T03:21:31Z
modified: 2026-10-23T03:21:31Z
---

# `_tools_/local-build/_tests_`

The tool's component tests, beside its code. They need no build slot and no real cargo: each test gives the
runner a temporary slot root and a fake cargo, so a test never sees or disturbs the machine's three slots.

| Suite | What it judges |
|---|---|
| [`slot-runner/`](slot-runner/INDEX.md) | slot acquisition and release, the job cap, a killed owner, an old stamp, `status` and the exit codes |

## Read next

[`../INDEX.md`](../INDEX.md) for the tool.
