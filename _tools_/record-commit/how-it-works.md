---
title: How record-commit works
created: 2026-10-24T05:00:49Z
modified: 2026-11-01T23:50:00Z
level: L2
version: 1.3.0
description: Why record-commit exists, the seven steps of a run, why every commit is parked on records/<seat> by default, and how a --main push that lost a race is replayed or rebuilt.
status: unverified
grounded_in:
  - source: the record-commit INDEX.md version 1.0.0 this was split from
---

# How `record-commit` works

## Why

The reflection tree is written by several sessions at once. Three decision entries and a seat log line were
once lost when an edit made on a lagging checkout replaced content that had landed meanwhile. The tool makes that mistake impossible for the files it is given.

## What it does, in order

1. **Fetch**, then make a temporary worktree at the fetched `origin/main`.
2. **Copy only the given files** there; nothing else in the live tree is read or written.
3. **Check each file's base** against `origin/main`. A normal file whose base differs is refused: its edit
   was made on content origin no longer has. `--file` uses the live checkout's `HEAD:path` as the base;
   `--staged DIR` uses `--base DIR/path` when given, else the live checkout's `HEAD:path`.
4. **Union append-only logs** (`_logs_/**.jsonl`, `execution-review-log.jsonl`, plus any `--append PATH`):
   origin's lines in their order, then the staged lines origin lacks. A log is never replaced; every line of
   both sides is verified present.
5. **Run the frontmatter validator on the whole tree** there. Only errors the record adds refuse it; errors
   `origin/main` already has, and warnings, are counted and listed with `--verbose`.
6. **Commit with explicit paths** as `D.Tadpole <gsk390@gmail.com>` (D-018), **park it** on `records/<seat>`
   (with `--main`, push `main`), then **read back** that the branch is that commit and that it carries every
   staged byte (and, for a log, every line).
7. With `--main` only, **fast-forward the live tree** with [`reflection-sync`](../reflection-sync/INDEX.md), so
   the next edit starts from the new origin.

## A push that lost a race

Under `--main`, a push rejected because another session landed first is **replayed** when the landed commits
touch none of the given files: rebased onto the new tip and pushed at once, up to five times. That cannot drop anyone's lines, and
wins against a busy remote where a full rebuild kept losing. Otherwise the attempt is **rebuilt from a fresh
origin** (fetch, new worktree, re-union, re-check) up to `--retries` times, default 2. It never rebases over a
change to a given file and never force-pushes.

## Parking, the default

Reflection main takes pull requests only, and a seat's direct push would land in the owner's KB cutover whenever
protection is off, so by default the tool never pushes main. The commit is **parked** on `refs/heads/records/<seat>`.
The seat is `--seat`, else the TEAM.yaml key of `$DSH_SESSION_ID`; with neither, the run exits 1 before anything is
committed. A missing branch is created at the commit, which sits on `origin/main`. A branch that main already
contains is fast-forwarded. Any other branch gets the commit rebuilt on its tip, where a file takes the staged bytes
and a log gains only its own lines. The branch is read back, the live tree is left as it was, and the run exits 0
with `parked on records/<seat> <sha>` as its last line. The coordinator gets the parked branches merged.

Under `--main`, a protected main's refusal (GitHub's GH006 or a ruleset's GH013) is never replayed as a race: the
commit is parked as above.
