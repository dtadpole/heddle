---
title: Review collect test coverage
created: 2026-10-24T05:01:11Z
modified: 2026-10-24T05:01:11Z
level: L2
version: 1.0.0
description: What the review-collect page suite builds and which behaviours its tests check
status: unverified
grounded_in:
  - source: the review-collect INDEX.md this was split from
  - source: _tools_/review-collect/_tests_/page/unit.test.mjs
---

# What the page suite covers

Twenty-two tests against a scratch bare origin, a reviewer clone, a fake seat with commits ahead and uncommitted
edits, a fake inbox, action log and review log: the roster reader, the pushed branch beside local HEAD, the
defaults derived from the record (and the refusal without one), scope parsing and the four verdicts, porcelain
parsing, the report-versus-peer-message rule, the ledger cutoff, run detection on one line, across a fenced
multi-line command and in an article the INDEX links in the same folder, the usage-line and import-line false
positives, the candidate rule for broad scopes, the full page, a clean seat, a missing worktree, an unknown seat,
and that the seat worktree is unchanged after a run.

The suite and the rules it keeps are in [`_tests_/page/`](_tests_/page/INDEX.md).
