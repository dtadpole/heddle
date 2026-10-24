---
title: Review collect usage
created: 2026-10-24T05:01:11Z
modified: 2026-10-24T05:01:11Z
level: L2
version: 1.0.0
description: How to run review-collect, its options and exit codes, and what it never writes
status: unverified
grounded_in:
  - source: the review-collect INDEX.md this was split from
---

# Using `review-collect`

## The team record and the base

The team record is named, never built in: `--team` or `HEDDLE_TEAM_FILE` points at the team's `TEAM.yaml`, which
lives in the team's private tree. Run it from the reviewer's own worktree: that clone is fetched and its
`origin/main` is the base every seat is compared with. Everything else is read only.

## Options

`--team FILE` (or `HEDDLE_TEAM_FILE`; required), `--repo DIR` (the reviewer's clone; default the current
checkout), `--worktree DIR`, `--branch NAME` (default `hd/<seat>`), `--inbox-home DIR`, `--action-log FILE`,
`--review-log FILE`, `--since ISO`, `--reporter SEAT` (the last four default from the record). No dependency
beyond Node and git.

## Exit codes

Exit `0` with the page, `1` when the seat, the team file or the reviewer's checkout is missing.

## What it does not do

It writes nothing in the seat's worktree (`git --no-optional-locks`, so not even an index refresh), never marks a
message read, and never fetches into the seat's clone. If the seat clone lacks the fetched `origin/main`, the page
says so and compares against the seat's own `origin/main`. A planned seat with no worktree still gets its report
and ledger, with the worktree marked `MISSING`.
