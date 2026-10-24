---
title: Review collect evidence sources
created: 2026-10-24T05:01:11Z
modified: 2026-10-24T05:01:11Z
level: L2
version: 1.0.0
description: Where each section of the review-collect page comes from, and how the runs, the tree and the reporter are found
status: unverified
grounded_in:
  - source: the review-collect INDEX.md this was split from
  - source: _tools_/review-collect/review-collect.mjs, linkedArticles and recordedRuns
---

# Where each section comes from

| Section | Where it comes from |
|---|---|
| `pushed` | `origin/hd/<seat>` in the reviewer's fetched clone: how far it is from main, and how many local commits are not pushed (or `NOT PUSHED`) |
| `tip`, `commits` | the seat worktree (`~/heddle--<seat>`, or the path in its `resource_identity_ref`) against the fetched `origin/main`; merges of main are counted, not listed |
| `scope check`, `files`, `uncommitted` | `git diff` and `git status` in the seat worktree, each path judged against the seat's `write_scopes` in `TEAM.yaml` ([scope-rules.md](scope-rules.md)), files grouped by crate, verifier or top folder |
| `last report`, `newer msg` | the team inboxes under `$REFLECTION_INBOX_HOME` (default `~/.reflection-inbox`): the seat's newest message to the record's owner gateway, and its newest message to anyone else when that is newer |
| `runs` | the INDEX files the seat's scope names (a crate, a tool, `rust/INDEX.md`) and the units it touched; the last line that records a command with a result, or a counted result just after a fenced command block, dated by the line or the heading above it. With none, the command the INDEX declares, labelled **declared, no recorded result** |
| `action log` | `_logs_/repo-actions/action-log.jsonl` in the team's tree, the seat's lines after its last entry in the record's `references.execution_review` log (`--since ISO` overrides) |

Recorded runs, and with none the declared command, are read from a unit's `INDEX.md` and from the articles that
INDEX links in the same folder (for a seat that splits its INDEX into an entry point plus `status.md` and similar),
never from links into other folders.

The tree is the record's `reflection.root_hint`, or the team file's folder minus its `project_path` when the hint
does not exist; the reporter is `coordination.reporting.owner_gateway`, else `record_owner`. Whatever the record
does not name is reported as a `note` line rather than guessed.

[page.md](page.md) shows an example page.
