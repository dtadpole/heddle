---
title: Review collect component tests
version: 1.0.0
description: The component suites of the review-collect tool, one folder per suite.
grounded_in:
  - source: _tools_/INDEX.md section Where the tests live
created: 2026-10-23T04:01:55Z
modified: 2026-10-23T04:01:55Z
---

# `_tools_/review-collect/_tests_`

The tool's component tests, beside its code. Every test builds its own bare origin, reviewer clone and fake seat,
with a fake inbox, action log and review log, so no test reads the real team.

| Suite | What it judges |
|---|---|
| [`page/`](page/INDEX.md) | the roster and scope readers, the path verdicts, the report, the recorded runs, the ledger and the page |

## Read next

[`../INDEX.md`](../INDEX.md) for the tool.
