---
title: Public hygiene gate
version: 1.0.0
description: Unit tests for the public-hygiene gate — the private list, the redacted report, the identity check and what the exit code says.
grounded_in:
  - source: _tools_/public-hygiene/gate.mjs
---

# `gate`

The rules the gate keeps: a literal is matched case-insensitively, a regex is compiled once and must not match
the empty string; a report never echoes a term; an added line, a path name, a commit message and a commit
identity are all judged; a clean range exits 0, a finding exits 1, and a gate that cannot run exits 2 without
judging the range.

```bash
node --test _tools_/public-hygiene/_tests_/gate/unit.test.mjs
```

**Browser mode: none.**

## Read next

[`../../INDEX.md`](../../INDEX.md) for the tool these rules belong to.
