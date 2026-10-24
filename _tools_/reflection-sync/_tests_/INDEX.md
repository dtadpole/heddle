---
title: Reflection sync component tests
version: 1.0.0
description: The component suites of the reflection-sync tool, one folder per suite.
grounded_in:
  - source: _tools_/INDEX.md section Where the tests live
created: 2026-10-23T03:33:27Z
modified: 2026-10-23T03:33:27Z
---

# `_tools_/reflection-sync/_tests_`

The tool's component tests, beside its code. Each integration test builds its own bare origin and three clones,
so a test never touches the real checkout.

| Suite | What it judges |
|---|---|
| [`fast-forward/`](fast-forward/INDEX.md) | the plan, the refusals, the log union, the backups, the dry run and the exit codes |

## Read next

[`../INDEX.md`](../INDEX.md) for the tool.
