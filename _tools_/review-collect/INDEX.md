---
title: Review collect
version: 1.0.0
description: One read-only command that prints the raw evidence for a member review — the seat's tip against origin/main, its commits and files judged against its write scope, its uncommitted paths, its last report, its recorded test and verifier runs, and its action-log lines since the last review.
grounded_in:
  - source: _projects_/heddle/TEAM.yaml, coordination.member_review — one member per 15-minute review pass, verdicts appended to execution-review-log.jsonl
  - source: the coordinator's request 2026-10-22, a member review from raw evidence took ten minutes of git and log reading
---

# `review-collect`

The coordinator reviews one member every pass, from raw evidence. This gathers that evidence into one page in
about two seconds, so the review time goes to judging rather than to `git log` and log reading.

```bash
node _tools_/review-collect/review-collect.mjs --team <TEAM.yaml> --seat developer-ten
HEDDLE_TEAM_FILE=<TEAM.yaml> node _tools_/review-collect/review-collect.mjs --seat developer-ten
```

The team record is named, never built in: `--team` or `HEDDLE_TEAM_FILE` points at the team's `TEAM.yaml`, which
lives in the team's private tree. Run it from the reviewer's own worktree: that clone is fetched and its
`origin/main` is the base every seat is compared with. Everything else is read only.

## The page

```text
review-collect: developer-ten  [hd] Developer Ten  lane ui
team        <the TEAM.yaml given>
focus       server, token and stream — the server, token and stream first, so every feature crate can mount its routes
worktree    ~/heddle--developer-ten  branch hd/developer-ten  HEAD 72fdb4fb824d
tip         24 ahead, 0 behind  origin/main 59fd96f (2026-10-22T20:51:13-07:00)
pushed      origin/hd/developer-ten 72fdb4f: 24 ahead, 0 behind origin/main; local HEAD is the pushed tip
scope check clean: 0 committed and 0 uncommitted path(s) outside the write scope
commits     19 ahead with subjects (5 merge(s) of main not listed; 24 commits total)
  f09a628  2026-10-22T20:48  fix(heddle-server): answer a stale approval with answered:false
  ...
files       16 changed vs origin/main
  crate heddle-server (16) [in scope (heddle rust/crates/heddle-server/)]
    rust/crates/heddle-server/Cargo.toml
    ...
uncommitted 0 path(s)
  none
last report 2026-10-22T20:54:34-07:00 to hd-coordinator [fyi] backend candidate abdf20c: heddle-server 121 tests pass
  (the first twelve lines of the body)
newer msg   2026-10-22T20:57:12-07:00 to developer-twelve [answer] ...
runs        1 recorded in a scoped INDEX
  rust/crates/heddle-server/INDEX.md:25
    `cargo test -p heddle-server` is green (122 tests). The door is judged over a real socket as
    command: cargo test -p heddle-server
action log  0 line(s) since 2026-10-22T20:51:00-07:00 (last seat line 2026-10-22T20:41:05-07:00)
scope       include: rust/crates/heddle-server/
```

| Section | Where it comes from |
|---|---|
| `pushed` | `origin/hd/<seat>` in the reviewer's fetched clone: how far it is from main, and how many local commits are not pushed (or `NOT PUSHED`) |
| `tip`, `commits` | the seat worktree (`~/heddle--<seat>`, or the path in its `resource_identity_ref`) against the fetched `origin/main`; merges of main are counted, not listed |
| `scope check`, `files`, `uncommitted` | `git diff` and `git status` in the seat worktree, each path judged against the seat's `write_scopes` in `TEAM.yaml`, files grouped by crate, verifier or top folder |
| `last report`, `newer msg` | the team inboxes under `$REFLECTION_INBOX_HOME` (default `~/.reflection-inbox`): the seat's newest message to the record's owner gateway, and its newest message to anyone else when that is newer |
| `runs` | the INDEX files the seat's scope names (a crate, a tool, `rust/INDEX.md`) and the units it touched; the last line that records a command with a result, or a counted result just after a fenced command block, dated by the line or the heading above it. With none, the command the INDEX declares, labelled **declared, no recorded result** |
| `action log` | `_logs_/repo-actions/action-log.jsonl` in the team's tree, the seat's lines after its last entry in the record's `references.execution_review` log (`--since ISO` overrides) |

The tree is the record's `reflection.root_hint`, or the team file's folder minus its `project_path` when the hint
does not exist; the reporter is `coordination.reporting.owner_gateway`, else `record_owner`. Whatever the record
does not name is reported as a `note` line rather than guessed.

## How a path is judged

A write scope is prose with paths in it. Each path-shaped token becomes a prefix (`rust/crates/heddle-server/`,
`_tools_/verify-runner/`, `rust/INDEX.md`; `the backend _verifiers_ folders` becomes `_verifiers_/`); a scope with
no path (`merges of the backend lane onto main`) is listed as **unparsed** and never used to call a path outside.
A path is `in scope`, `EXCLUDED` (it matches an excluded prefix), `OUTSIDE SCOPE`, or `no path scope recorded`
when the seat has no machine-readable scope at all. The verdict is evidence for the reviewer, not a ruling: a
lockfile merge or an agreed exception reads as outside and is the reviewer's call.

## What it does not do

It writes nothing in the seat's worktree (`git --no-optional-locks`, so not even an index refresh), never marks a
message read, and never fetches into the seat's clone. If the seat clone lacks the fetched `origin/main`, the page
says so and compares against the seat's own `origin/main`. A planned seat with no worktree still gets its report
and ledger, with the worktree marked `MISSING`.

## Options

`--team FILE` (or `HEDDLE_TEAM_FILE`; required), `--repo DIR` (the reviewer's clone; default the current
checkout), `--worktree DIR`, `--branch NAME` (default `hd/<seat>`), `--inbox-home DIR`, `--action-log FILE`,
`--review-log FILE`, `--since ISO`, `--reporter SEAT` (the last four default from the record). Exit `0` with the
page, `1` when the seat, the team file or the reviewer's checkout is missing. No dependency beyond Node and git.

## Tests

```bash
node --test _tools_/review-collect/_tests_/page/unit.test.mjs
```

Last run 2026-10-22 21:30 PDT, on hd/tool-developer with main c4c9292 merged: `node --test _tools_/review-collect/_tests_/page/unit.test.mjs`, 20 passed, 0 failed.

Twenty tests against a scratch bare origin, a reviewer clone, a fake seat with commits ahead and uncommitted edits,
a fake inbox, action log and review log: the roster reader, the pushed branch beside local HEAD, the defaults derived from the record (and the refusal
without one), scope parsing and the four verdicts, porcelain parsing,
the report-versus-peer-message rule, the ledger cutoff, run detection on one line and across a fenced multi-line
command, the usage-line and import-line false positives, the candidate rule for broad scopes, the full page, a clean
seat, a missing worktree, an unknown seat, and that the seat worktree is unchanged after a run.

## Read next

[`../load-check/INDEX.md`](../load-check/INDEX.md) for the machine half of a review pass, and
[`../public-hygiene/INDEX.md`](../public-hygiene/INDEX.md) for the gate a merge passes.
