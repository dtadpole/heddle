---
title: Load check component tests
version: 1.0.0
description: The component suites of the load-check tool, one folder per suite.
grounded_in:
  - source: _tools_/INDEX.md section Where the tests live
---

# `_tools_/load-check/_tests_`

The tool's component tests, beside its code. They feed the report the text a Mac answers with, so a test
never depends on how busy the machine happens to be.

| Suite | What it judges |
|---|---|
| [`report/`](report/INDEX.md) | the parsers, slot states, worktree grouping, thresholds and exit codes |

## Read next

[`../INDEX.md`](../INDEX.md) for the tool.
