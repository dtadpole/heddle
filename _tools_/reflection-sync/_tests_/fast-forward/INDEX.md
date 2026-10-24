---
title: Reflection sync fast-forward
version: 1.0.0
description: Unit tests for the shared-checkout fast-forward — what it moves, what it refuses, and what it reads back.
grounded_in:
  - source: _tools_/reflection-sync/reflection-sync.mjs
created: 2026-10-23T03:33:27Z
modified: 2026-10-23T03:33:27Z
---

# `fast-forward`

The rules the sync keeps: a commit the remote lacks, a staged change, or a local edit that differs from the
remote blocks the fast-forward and changes nothing; an unrelated local edit survives; an identical untracked
copy is moved aside, not lost; an append-only log is unioned unless the caller says otherwise; a dry run moves
nothing; success is only reported after the new tip is read back.

```bash
node --test _tools_/reflection-sync/_tests_/fast-forward/unit.test.mjs
```

**Browser mode: none.**

## Read next

[`../../INDEX.md`](../../INDEX.md) for the tool these rules belong to.
