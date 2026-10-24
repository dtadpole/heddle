---
title: Record commit rules
version: 1.0.0
description: Unit tests for record-commit — a stale base is refused, a log keeps both sides, a failed read-back is an error, and a landed commit syncs the live tree.
grounded_in:
  - source: _tools_/record-commit/record-commit.mjs
created: 2026-10-23T03:43:51Z
modified: 2026-10-23T03:43:51Z
---

# `record`

The rules the helper keeps: a file is copied into a temporary worktree at a fresh `origin/main`, never
committed in the live checkout; a base that origin has moved past is refused; an append-only log is unioned and
verified line by line; the frontmatter validator runs over the whole tree; the push is read back from
`origin/main` byte for byte; a push race is rebuilt rather than retried blindly; and the live tree is
fast-forwarded only after the record is safe.

```bash
node --test _tools_/record-commit/_tests_/record/unit.test.mjs
```

**Browser mode: none.**

## Read next

[`../../INDEX.md`](../../INDEX.md) for the tool these rules belong to.
