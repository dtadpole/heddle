---
title: Build host component tests
version: 1.0.0
description: The component suites of the build-host tool, one folder per suite.
grounded_in:
  - source: _tools_/INDEX.md section Where the tests live
---

# `_tools_/build-host/_tests_`

The tool's component tests, beside its code. They need no host, no network and no browser: they judge the
scripts and arguments the tool builds.

| Suite | What it judges |
|---|---|
| [`command-rules/`](command-rules/INDEX.md) | host selection, worktree naming and creation, rsync, remote runs, tests, verify and bootstrap scripts |

## Read next

[`../INDEX.md`](../INDEX.md) for the tool.
