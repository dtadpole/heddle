---
title: How record-commit works
created: 2026-10-24T05:00:49Z
modified: 2026-10-26T14:40:22Z
level: L2
version: 1.1.0
description: Why record-commit exists, the seven steps of a run, and how a push that lost a race is replayed or rebuilt.
status: unverified
grounded_in:
  - source: the record-commit INDEX.md version 1.0.0 this was split from
---

# How `record-commit` works

## Why

The reflection tree is written by several sessions at once. Three decision entries and one seat log line were
lost under this tree's nose because an edit made on a lagging checkout replaced content that had landed
meanwhile. The tool makes that mistake impossible for the files it is given.

## What it does, in order

1. **Fetch**, then create a temporary worktree of the live checkout at the fetched `origin/main`.
2. **Copy only the given files** there; nothing else in the live tree is read or written.
3. **Check each file's base** against `origin/main`. A normal file whose base differs is refused — that edit
   was made on a version origin no longer has. `--file` uses the live checkout's `HEAD:path` as the base;
   `--staged DIR` uses `--base DIR/path` when given, else the live checkout's `HEAD:path`.
4. **Union append-only logs** (`_logs_/**.jsonl`, `execution-review-log.jsonl`, plus any `--append PATH`):
   origin's lines in their order, then the staged lines origin lacks. A log is never replaced, and the tool
   verifies every line of both sides is present.
5. **Run the frontmatter validator on the whole tree** in the temporary worktree. Errors refuse the commit;
   warnings are counted and only listed with `--verbose`.
6. **Commit with explicit paths** as `D.Tadpole <gsk390@gmail.com>` (D-018), **push `main`**, then **read back**
   that `origin/main` is that commit and that it carries every staged byte (and, for a log, every line).
7. **Fast-forward the live tree** with [`reflection-sync`](../reflection-sync/INDEX.md), so the next edit starts
   from the new origin.

## A push that lost a race

A push rejected because another session landed first is **replayed** when the landed commits touch none of the
given files: rebased onto the new tip and pushed at once, up to five times. That cannot drop anyone's lines, and it
wins against a busy remote where a full rebuild kept losing. Otherwise the attempt is **rebuilt from a fresh
origin** (fetch, new worktree, re-union, re-check) up to `--retries` times, default 2. It never rebases over a
change to a given file and never force-pushes.
