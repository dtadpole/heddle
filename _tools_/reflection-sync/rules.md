---
title: Reflection sync rules
created: 2026-10-24T05:00:21Z
modified: 2026-10-24T05:00:21Z
level: L2
version: 1.0.0
description: When reflection-sync refuses a fast-forward, what it does instead of refusing, what it never does, and where its backups go
status: unverified
grounded_in:
  - source: the reflection-sync INDEX.md version 1.0.0 this was split from, section What it refuses
---

# Reflection sync rules

## What it refuses

A fast-forward is refused, changing nothing, when:

- the checkout has a commit the remote lacks — commits belong in a temporary worktree, not here;
- the index has a staged change, or an unmerged path;
- a tracked file is modified locally **and** the remote also changes it, with content different from the
  remote's: another session is mid-edit on that file, so the coordinator retries next pass;
- an untracked file sits at a path the remote adds and differs from the remote's version.

## What it does instead of refusing

- a modified file the remote does not touch is **kept**; the fast-forward leaves it alone;
- a modified file whose local content already equals the remote's is **refreshed**;
- an untracked file byte-identical to the remote's addition is **moved aside** to the backup directory and the
  remote's copy is checked out — the content is the same, so nothing is lost;
- an append-only log (`_logs_/**.jsonl`, `execution-review-log.jsonl`) that both sides appended to is
  **unioned**: the remote's lines in their order, then the local lines the remote lacks. Every line is kept and
  the fast-forward is not blocked. `--no-union-logs` disables this and makes such a log a refusal.

## What it never does

It never stashes, never resets the working tree, and never uncommits anything.

## Backups

Backups of anything it moved aside or unioned are under `$TMPDIR/reflection-sync-backup/<stamp>/`, or the
directory given with `--backup`.

## Read next

[INDEX.md](INDEX.md) for the tool, and [results.md](results.md) for what it reports after a fast-forward.
