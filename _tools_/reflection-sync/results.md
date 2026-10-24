---
title: Reflection sync results
created: 2026-10-24T05:00:21Z
modified: 2026-10-24T05:00:21Z
level: L2
version: 1.0.0
description: How reflection-sync reads back the new tip before reporting success, what the report names, and its exit codes
status: unverified
grounded_in:
  - source: the reflection-sync INDEX.md version 1.0.0 this was split from, sections The read-back and Exit codes
---

# Reflection sync results

## The read-back

After the merge it re-reads `HEAD` and `origin/main` and only reports success when both equal the tip it fetched;
a mismatch is an error. The report names the before and after commit, the files it touched, and the kept local
edits — never their content.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | fast-forwarded, or already up to date (with `--dry-run`: would fast-forward) |
| `1` | could not run: not a checkout, detached HEAD, fetch or merge failed |
| `2` | refused: local work differs; nothing was changed |

## Read next

[INDEX.md](INDEX.md) for the tool, and [rules.md](rules.md) for what it refuses and what it changes.
