---
title: Record commit component tests
version: 1.0.0
description: The component suites of the record-commit tool, one folder per suite.
grounded_in:
  - source: _tools_/INDEX.md section Where the tests live
created: 2026-10-23T03:43:51Z
modified: 2026-10-23T03:43:51Z
---

# `_tools_/record-commit/_tests_`

The tool's component tests, beside its code. Every integration test builds a bare origin and three scratch
clones, so no test reads or writes the real reflection tree.

| Suite | What it judges |
|---|---|
| [`record/`](record/INDEX.md) | the base check, the log union, the validator call, the read-back, the push race and the exit codes |

## Read next

[`../INDEX.md`](../INDEX.md) for the tool.
