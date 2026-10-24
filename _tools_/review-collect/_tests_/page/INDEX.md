---
title: Review collect page
version: 1.0.0
description: Unit tests for review-collect — every section of the review page, built from a scratch repository and a fake seat.
grounded_in:
  - source: _tools_/review-collect/review-collect.mjs
created: 2026-10-23T04:01:55Z
modified: 2026-10-23T04:01:55Z
---

# `page`

The rules the page keeps: a seat's commits and paths are compared with a freshly fetched `origin/main` and judged
against its write scope; a scope with no path is never used to call a path outside; the report is the seat's newest
message to the coordinator, with a newer peer message kept beside it; a recorded run needs a result, on its line or
just after a fenced command, and a usage or import line is not one; a broad scope credits only the units the seat
touched; the ledger starts after the seat's last review; and the seat's worktree is unchanged by the run.

```bash
node --test _tools_/review-collect/_tests_/page/unit.test.mjs
```

**Browser mode: none.**

## Read next

[`../../INDEX.md`](../../INDEX.md) for the tool these rules belong to.
