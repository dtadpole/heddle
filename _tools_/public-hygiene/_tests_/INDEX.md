---
title: Public hygiene component tests
version: 1.0.0
description: The component suites of the public-hygiene gate, one folder per suite.
grounded_in:
  - source: _tools_/INDEX.md section Where the tests live
---

# `_tools_/public-hygiene/_tests_`

The tool's component tests, beside its code. They need no network and no real repository: each integration
test builds a throwaway repository and a throwaway identifier list.

| Suite | What it judges |
|---|---|
| [`gate/`](gate/INDEX.md) | the identifier list, matching and redaction, the diff/log parsers, identity, the built-in rule and the exit codes |

## Read next

[`../INDEX.md`](../INDEX.md) for the tool.
